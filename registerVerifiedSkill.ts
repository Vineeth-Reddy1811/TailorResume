import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

type VerifiedSkill = {
  canonical: string;
  aliases?: string[];
  verified: boolean;
  userConfirmed?: boolean;
  category?: string;
  source?: string;
};

const PROJECT_ROOT = process.cwd();
const DEFAULT_PROFILE = path.join(PROJECT_ROOT, "Data", "input", "experience-profile.json");
const SKILL_DICTIONARY = path.join(PROJECT_ROOT, "config", "skill-dictionary.json");

function normalizeSkillTerm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function usage(): never {
  throw new Error(
    'Usage: npm run resume:skill:confirm -- --canonical "Skill name" [--aliases "alias one, alias two"] [--category "Tools & Platforms"] [--source "User-confirmed experience"] [--profile path/to/experience-profile.json]'
  );
}

function parseArgs(argv: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key.startsWith("--") || !value || value.startsWith("--")) usage();
    values.set(key, value);
    index += 1;
  }
  const canonical = values.get("--canonical")?.trim();
  if (!canonical) usage();
  const allowed = new Set(["--canonical", "--aliases", "--category", "--source", "--profile"]);
  for (const key of values.keys()) if (!allowed.has(key)) usage();
  return {
    canonical,
    aliases: (values.get("--aliases") ?? "").split(",").map((alias) => alias.trim()).filter(Boolean),
    category: values.get("--category")?.trim(),
    source: values.get("--source")?.trim(),
    profile: path.resolve(values.get("--profile") ?? DEFAULT_PROFILE),
  };
}

function rejectSharedDictionaryCollisions(canonical: string, aliases: string[]) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(SKILL_DICTIONARY, "utf8"));
  } catch {
    throw new Error(`Could not read skill dictionary: ${SKILL_DICTIONARY}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`Invalid skill dictionary: ${SKILL_DICTIONARY}`);
  const proposedTerms = [canonical, ...aliases].map(normalizeSkillTerm);
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const requirement = item as { canonical?: unknown; aliases?: unknown };
    if (typeof requirement.canonical !== "string" || !Array.isArray(requirement.aliases)) continue;
    if (requirement.canonical.toLowerCase() === canonical.toLowerCase()) continue;
    const existingTerms = [requirement.canonical, ...requirement.aliases.filter((alias): alias is string => typeof alias === "string")]
      .map(normalizeSkillTerm);
    if (existingTerms.some((term) => proposedTerms.includes(term))) {
      throw new Error(`A canonical name or alias conflicts with shared skill ${requirement.canonical}.`);
    }
  }
}

function acquireProfileLock(lockPath: string): void {
  try {
    fs.writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let owner = "unknown";
    try {
      const ownerPid = Number(fs.readFileSync(lockPath, "utf8").trim());
      if (Number.isInteger(ownerPid) && ownerPid > 0) owner = `process ${ownerPid}`;
    } catch {
      // The lock may be in the middle of being initialized.
    }
    throw new Error(`Could not acquire the profile update lock (${lockPath}); ${owner} may be updating it. If no registration is running, remove this stale lock file and retry.`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const lockPath = `${args.profile}.lock`;
  acquireProfileLock(lockPath);

  try {
    let parsed: {
      facts?: unknown;
      verifiedSkills?: unknown;
      [key: string]: unknown;
    };
    try {
      parsed = JSON.parse(fs.readFileSync(args.profile, "utf8")) as typeof parsed;
    } catch {
      throw new Error(`Could not parse experience profile: ${args.profile}`);
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.facts)) {
      throw new Error("The experience profile must contain a facts array.");
    }
    if (parsed.verifiedSkills !== undefined && !Array.isArray(parsed.verifiedSkills)) {
      throw new Error("The experience profile verifiedSkills property must be an array.");
    }
    const skills = (parsed.verifiedSkills ?? []) as VerifiedSkill[];
    for (const [index, skill] of skills.entries()) {
      if (!skill || typeof skill !== "object" || typeof skill.canonical !== "string" || !skill.canonical.trim() ||
          (skill.aliases !== undefined && (!Array.isArray(skill.aliases) || skill.aliases.some((alias) => typeof alias !== "string")) ) ||
          typeof skill.verified !== "boolean" ||
          (skill.userConfirmed !== undefined && typeof skill.userConfirmed !== "boolean") ||
          (skill.category !== undefined && typeof skill.category !== "string") ||
          (skill.source !== undefined && typeof skill.source !== "string")) {
        throw new Error(`Existing verifiedSkills entry ${index + 1} is invalid; correct it before registering another skill.`);
      }
    }
    const existingMatches = skills.filter((skill) => skill.canonical.toLowerCase() === args.canonical.toLowerCase());
    if (existingMatches.length > 1) throw new Error(`The profile has multiple entries for ${args.canonical}; resolve them before updating.`);
    const existing = existingMatches[0];
    const aliases = [...new Set([args.canonical, ...args.aliases])];
    const proposedTerms = [args.canonical, ...aliases].map(normalizeSkillTerm);
    const collision = skills.find((skill) => skill.canonical.toLowerCase() !== args.canonical.toLowerCase() &&
      [skill.canonical, ...(skill.aliases ?? [])].some((term) => proposedTerms.includes(normalizeSkillTerm(term))));
    if (collision) throw new Error(`A canonical name or alias conflicts with the existing skill ${collision.canonical}.`);
    rejectSharedDictionaryCollisions(args.canonical, aliases);
    if (existing) {
      existing.aliases = [...new Set([...(existing.aliases ?? []), ...aliases])];
      existing.category = args.category ?? existing.category ?? "Tools & Platforms";
      existing.source = args.source ?? existing.source ?? "User-confirmed skill";
      existing.verified = true;
      existing.userConfirmed = true;
    } else {
      skills.push({
        canonical: args.canonical,
        aliases,
        verified: true,
        userConfirmed: true,
        category: args.category ?? "Tools & Platforms",
        source: args.source ?? "User-confirmed skill",
      });
    }
    parsed.verifiedSkills = skills;
    const temporaryDirectory = fs.mkdtempSync(path.join(path.dirname(args.profile), ".skill-confirm-"));
    try {
      const temporaryPath = path.join(temporaryDirectory, `${randomUUID()}.json`);
      fs.writeFileSync(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
      fs.renameSync(temporaryPath, args.profile);
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  } finally {
    try {
      if (Number(fs.readFileSync(lockPath, "utf8").trim()) === process.pid) {
        fs.rmSync(lockPath, { force: true });
      }
    } catch {
      // The lock file may already have been cleaned up.
    }
  }
  console.log(`Saved user-confirmed skill: ${args.canonical}`);
  console.log(`Profile: ${args.profile}`);
  console.log("Rerun resume:propose to match it in this and future job descriptions.");
}

main();
