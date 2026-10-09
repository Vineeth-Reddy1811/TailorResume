import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { isBulletParagraph } from "./docxStructure";

type ResumeParagraph = {
  id: string;
  text: string;
  section: string;
  role: string | null;
  isBullet: boolean;
  numId: string | null;
};

type Requirement = {
  canonical: string;
  aliases: string[];
};

type Evidence = {
  paragraphId: string;
  section: string;
  role: string | null;
  text: string;
  isBullet: boolean;
  matchedRequirements: string[];
};

type ExperienceFact = {
  id: string;
  verified: boolean;
  userConfirmed?: boolean;
  requirements: string[];
  text: string;
  supplementText?: string;
  targetParagraphId?: string;
  afterParagraphId?: string;
  source?: string;
};

type ExperienceProfile = {
  sourceResume?: string;
  sourceSha256?: string;
  facts: ExperienceFact[];
  verifiedSkills?: VerifiedSkill[];
};

type VerifiedSkill = {
  canonical: string;
  aliases: string[];
  verified: boolean;
  userConfirmed?: boolean;
  category: string;
  source?: string;
};

type RequirementPlan = {
  canonical: string;
  priority: "required" | "preferred";
  action: "keep" | "rewrite" | "add" | "unsupported";
  evidenceMatchType: "canonical-term" | "dictionary-alias" | "verified-profile-fact" | "none";
  evidenceParagraphIds: string[];
  changeId?: string;
  profileFactId?: string;
  userConfirmed?: boolean;
  reason: string;
};

type ChangeRecord = {
  id: string;
  action: "rewrite" | "add";
  matchType: "similar-existing-line" | "new-experience-line" | "technical-skills-section-update";
  status: "proposed";
  sourceParagraphId?: string;
  afterParagraphId?: string;
  section: string;
  role: string | null;
  originalText?: string;
  proposedText: string;
  requirements: string[];
  profileFactId: string;
  userConfirmed: boolean;
  source: string;
};

type Report = {
  schemaVersion: 1;
  mode: "deterministic-no-ai";
  resume: string;
  jobDescription: string;
  experienceProfile: string;
  sourceSha256: string;
  jobDescriptionSha256: string;
  requirements: RequirementPlan[];
  changes: ChangeRecord[];
  unsupportedRequirements: string[];
  learnedSkills: string[];
  manualReview: string[];
  applyManifest: {
    sourceResume: string;
    sourceSha256: string;
    experienceProfile: string;
    userConfirmedRequirements: string[];
    additions: Array<Record<string, unknown>>;
  };
};

const PROJECT_ROOT = process.cwd();
const DEFAULT_RESUME = path.join(PROJECT_ROOT, "Data", "input", "Resume.docx");
const DEFAULT_OUTPUT = path.join(PROJECT_ROOT, "Data", "out");
const DEFAULT_PROFILE = path.join(PROJECT_ROOT, "Data", "input", "experience-profile.json");
const SKILL_DICTIONARY = path.join(PROJECT_ROOT, "config", "skill-dictionary.json");

const SECTION_ALIASES: Record<string, string> = {
  SUMMARY: "Summary",
  "PROFESSIONAL EXPERIENCE": "Professional Experience",
  EXPERIENCE: "Professional Experience",
  EDUCATION: "Education",
  PROJECTS: "Projects",
  CERTIFICATIONS: "Certifications",
  "TECHNICAL KNOWLEDGE": "Technical Skills",
  "TECHNICAL SKILLS": "Technical Skills",
  SKILLS: "Technical Skills",
};

function usage(): never {
  throw new Error(
    "Usage: npm run resume:propose -- --job-description path/to/job-description.txt [--resume path/to/resume.docx] [--experience-profile path/to/profile.json] [--output path/to/output]"
  );
}

function parseArgs(argv: string[]) {
  let resume = DEFAULT_RESUME;
  let jobDescription: string | null = null;
  let experienceProfile = DEFAULT_PROFILE;
  let output = DEFAULT_OUTPUT;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--resume" && value) {
      resume = path.resolve(value);
      i += 1;
    } else if (arg === "--job-description" && value) {
      jobDescription = path.resolve(value);
      i += 1;
    } else if (arg === "--experience-profile" && value) {
      experienceProfile = path.resolve(value);
      i += 1;
    } else if (arg === "--output" && value) {
      output = path.resolve(value);
      i += 1;
    } else {
      usage();
    }
  }

  if (!jobDescription) usage();
  return { resume, jobDescription, experienceProfile, output };
}

function readDocxXml(docxPath: string): string {
  try {
    return execFileSync("unzip", ["-p", docxPath, "word/document.xml"], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    throw new Error(
      `Could not read word/document.xml from ${docxPath}. Ensure the file is a valid DOCX and the unzip command is available.`
    );
  }
}

function readDocxStylesXml(docxPath: string): string {
  try {
    return execFileSync("unzip", ["-p", docxPath, "word/styles.xml"], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    return "";
  }
}

function xmlDecode(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlAttribute(xml: string, element: string, attribute: string): string | null {
  const match = xml.match(new RegExp(`<${element}\\b[^>]*\\b${attribute}="([^"]+)"`));
  return match ? xmlDecode(match[1]) : null;
}

function paragraphText(xml: string): string {
  const pieces: string[] = [];
  const tokenPattern = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g;
  for (const match of xml.matchAll(tokenPattern)) {
    if (match[1] !== undefined) {
      pieces.push(xmlDecode(match[1]));
    } else {
      pieces.push(" ");
    }
  }
  return pieces.join("").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function extractParagraphs(documentXml: string, stylesXml: string): ResumeParagraph[] {
  const paragraphXml = documentXml.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? [];
  let section = "Header";

  const paragraphs = paragraphXml.map((xml, index): ResumeParagraph => {
    const text = paragraphText(xml);
    const normalizedHeading = text.replace(/[:：]+$/, "").trim().toUpperCase();
    if (SECTION_ALIASES[normalizedHeading]) {
      section = SECTION_ALIASES[normalizedHeading];
    }

    const numPr = xml.match(/<w:numPr\b[\s\S]*?<\/w:numPr>/)?.[0] ?? "";
    return {
      id: `p-${String(index + 1).padStart(4, "0")}`,
      text,
      section,
      role: null,
      isBullet: isBulletParagraph(xml, stylesXml),
      numId: xmlAttribute(numPr, "w:numId", "w:val"),
    };
  });

  let currentRole: string | null = null;
  const datePattern = /\b(?:19|20)\d{2}\b|\bpresent\b/i;
  for (let index = 0; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index];
    if (paragraph.section !== "Professional Experience") {
      currentRole = null;
      continue;
    }
    if (paragraph.isBullet) {
      paragraph.role = currentRole;
      continue;
    }
    if (!datePattern.test(paragraph.text)) continue;

    const previous = paragraphs[index - 1];
    const previousHeading = previous
      ? previous.text.replace(/[:：]+$/, "").trim().toUpperCase()
      : "";
    if (
      previous &&
      previous.section === "Professional Experience" &&
      !previous.isBullet &&
      previous.text.length > 0 &&
      !datePattern.test(previous.text) &&
      !SECTION_ALIASES[previousHeading]
    ) {
      currentRole = `${previous.text} ${paragraph.text}`.replace(/\s+/g, " ").trim();
      previous.role = currentRole;
    } else {
      currentRole = paragraph.text;
    }
    paragraph.role = currentRole;
  }

  return paragraphs;
}

function matchesPhrase(text: string, phrase: string): boolean {
  const normalize = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const normalizedText = normalize(text);
  const normalizedPhrase = normalize(phrase);
  return normalizedPhrase.length > 0 &&
    ` ${normalizedText} `.includes(` ${normalizedPhrase} `);
}

function isSectionHeading(text: string): boolean {
  const normalizedHeading = text.replace(/[:：]+$/, "").trim().toUpperCase();
  return Boolean(SECTION_ALIASES[normalizedHeading]);
}

function matchingAliases(text: string, requirement: Requirement): string[] {
  return requirement.aliases.filter((alias) => matchesPhrase(text, alias));
}

function loadRequirements(verifiedSkills: VerifiedSkill[] = []): Requirement[] {
  if (!fs.existsSync(SKILL_DICTIONARY)) {
    throw new Error(`Skill dictionary not found: ${SKILL_DICTIONARY}`);
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(SKILL_DICTIONARY, "utf8"));
  if (!Array.isArray(parsed) || parsed.some((item) => {
    if (!item || typeof item !== "object") return true;
    const candidate = item as { canonical?: unknown; aliases?: unknown };
    return typeof candidate.canonical !== "string" || !Array.isArray(candidate.aliases) || candidate.aliases.some((alias) => typeof alias !== "string");
  })) {
    throw new Error(`Invalid skill dictionary: ${SKILL_DICTIONARY}`);
  }
  const requirements = parsed as Requirement[];
  for (const skill of verifiedSkills.filter((item) => item.verified)) {
    const existing = requirements.find((item) => item.canonical.toLowerCase() === skill.canonical.toLowerCase());
    if (existing) {
      existing.aliases = [...new Set([...existing.aliases, ...skill.aliases])];
    } else {
      requirements.push({ canonical: skill.canonical, aliases: [...new Set([skill.canonical, ...skill.aliases])] });
    }
  }
  const ownerByTerm = new Map<string, string>();
  for (const requirement of requirements) {
    for (const term of [requirement.canonical, ...requirement.aliases]) {
      const normalized = term.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const owner = ownerByTerm.get(normalized);
      if (owner && owner.toLowerCase() !== requirement.canonical.toLowerCase()) {
        throw new Error(`Skill term “${term}” maps to both ${owner} and ${requirement.canonical}; resolve the alias conflict in the skill dictionary or experience profile.`);
      }
      ownerByTerm.set(normalized, requirement.canonical);
    }
  }
  return requirements;
}

function loadExperienceProfile(filePath: string, resumePath: string, sourceSha256: string): ExperienceProfile {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Experience profile not found: ${filePath}. Copy Data/input/experience-profile.example.json and add verified facts.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new Error(`Could not parse experience profile: ${filePath}`);
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { facts?: unknown }).facts)) {
    throw new Error("Experience profile must contain a facts array.");
  }
  const candidate = parsed as {
    sourceResume?: unknown;
    sourceSha256?: unknown;
    facts: unknown[];
    verifiedSkills?: unknown;
  };
  if (typeof candidate.sourceResume === "string" && path.resolve(PROJECT_ROOT, candidate.sourceResume) !== resumePath) {
    throw new Error(`Experience profile sourceResume does not match --resume: ${candidate.sourceResume}`);
  }
  if (typeof candidate.sourceSha256 === "string" && candidate.sourceSha256 !== sourceSha256) {
    throw new Error("Source DOCX changed since the experience profile paragraph IDs were recorded.");
  }
  const facts = candidate.facts.map((item, index): ExperienceFact => {
    if (!item || typeof item !== "object") throw new Error(`Profile fact ${index + 1} must be an object.`);
    const fact = item as Partial<ExperienceFact>;
    if (
      typeof fact.id !== "string" || typeof fact.verified !== "boolean" ||
      !Array.isArray(fact.requirements) || fact.requirements.some((requirement) => typeof requirement !== "string") ||
      typeof fact.text !== "string" || !fact.text.trim() ||
      (fact.supplementText !== undefined && (typeof fact.supplementText !== "string" || !fact.supplementText.trim())) ||
      (fact.targetParagraphId && fact.afterParagraphId)
    ) {
      throw new Error(`Profile fact ${index + 1} needs id, verified, requirements, text, and at most one paragraph anchor.`);
    }
    return {
      id: fact.id,
      verified: fact.verified,
      userConfirmed: fact.userConfirmed === true,
      requirements: fact.requirements,
      text: fact.text.trim(),
      supplementText: fact.supplementText?.trim(),
      targetParagraphId: fact.targetParagraphId,
      afterParagraphId: fact.afterParagraphId,
      source: typeof fact.source === "string" ? fact.source : "verified experience profile",
    };
  });
  if (new Set(facts.map((fact) => fact.id)).size !== facts.length) {
    throw new Error("Experience profile fact IDs must be unique.");
  }
  if (candidate.verifiedSkills !== undefined && !Array.isArray(candidate.verifiedSkills)) {
    throw new Error("Experience profile verifiedSkills must be an array when supplied.");
  }
  const verifiedSkills = ((candidate.verifiedSkills ?? []) as unknown[]).map((item, index): VerifiedSkill => {
    if (!item || typeof item !== "object") throw new Error(`Verified skill ${index + 1} must be an object.`);
    const skill = item as Partial<VerifiedSkill>;
    if (
      typeof skill.canonical !== "string" || !skill.canonical.trim() ||
      (skill.aliases !== undefined && (!Array.isArray(skill.aliases) || skill.aliases.some((alias) => typeof alias !== "string"))) ||
      typeof skill.verified !== "boolean" ||
      (skill.category !== undefined && (typeof skill.category !== "string" || !skill.category.trim()))
    ) {
      throw new Error(`Verified skill ${index + 1} needs canonical, aliases, verified, and an optional non-empty category.`);
    }
    return {
      canonical: skill.canonical.trim(),
      aliases: [...new Set([skill.canonical.trim(), ...(skill.aliases ?? []).map((alias) => alias.trim()).filter(Boolean)])],
      verified: skill.verified,
      userConfirmed: skill.userConfirmed === true,
      category: skill.category?.trim() ?? "Tools & Platforms",
      source: typeof skill.source === "string" ? skill.source : "user-confirmed skill profile",
    };
  });
  return { sourceResume: candidate.sourceResume as string | undefined, sourceSha256: candidate.sourceSha256 as string | undefined, facts, verifiedSkills };
}

function fileSha256(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function priorityFor(jobDescription: string, aliases: string[]): "required" | "preferred" {
  const relevantLines = jobDescription.split(/\r?\n/).filter((line) => aliases.some((alias) => matchesPhrase(line, alias)));
  return relevantLines.length > 0 && relevantLines.every((line) => /\b(?:is a plus|are a plus|preferred)\b/i.test(line))
    ? "preferred" : "required";
}

function importantSkillExperienceText(skill: VerifiedSkill): string {
  const purposeBySkill: Record<string, string> = {
    jpa: "database persistence in Java applications",
    postgresql: "relational data storage and SQL query workflows",
    "power bi": "business intelligence reporting and data visualization",
  };
  const purposeByCategory: Record<string, string> = {
    "tools & platforms": "technical delivery workflows",
    "frameworks & libraries": "application feature development",
    languages: "software development tasks",
    databases: "application data and query workflows",
    "cloud & devops": "build, deployment, and operations workflows",
    "ai & machine learning": "AI integration and application workflows",
    "testing & monitoring": "test automation and software quality workflows",
  };
  const purpose = purposeBySkill[skill.canonical.toLowerCase()] ?? purposeByCategory[skill.category.toLowerCase()] ?? "role-related workflows";
  return `Applied ${skill.canonical} to support ${purpose}.`;
}

function skillCategoryFromResume(requirement: Requirement, paragraphs: ResumeParagraph[]): string {
  const skillLine = paragraphs.find((paragraph) => paragraph.section === "Technical Skills" && matchingAliases(paragraph.text, requirement).length > 0);
  const heading = skillLine?.text.match(/^\s*([^:：]{1,60})[:：]/)?.[1]?.trim();
  if (!heading) return "Tools & Platforms";
  const normalized = heading.toLowerCase();
  if (/framework|librar|web development/.test(normalized)) return "Frameworks & Libraries";
  if (/language/.test(normalized)) return "Languages";
  if (/database/.test(normalized)) return "Databases";
  if (/cloud|devops|infrastructure/.test(normalized)) return "Cloud & DevOps";
  if (/ai|machine learning/.test(normalized)) return "AI & Machine Learning";
  if (/testing|monitoring/.test(normalized)) return "Testing & Monitoring";
  return "Tools & Platforms";
}

function importantSkillAnchor(paragraphs: ResumeParagraph[], skill: VerifiedSkill): ResumeParagraph | undefined {
  const bullets = paragraphs.filter((paragraph) =>
    paragraph.isBullet && ["Professional Experience", "Projects"].includes(paragraph.section)
  );
  if (!bullets.length) return undefined;

  const termsByCategory: Record<string, string[]> = {
    "tools & platforms": ["data", "report", "dashboard", "analytics", "workflow"],
    "frameworks & libraries": ["application", "frontend", "backend", "api", "software"],
    languages: ["application", "develop", "software", "script", "api"],
    databases: ["data", "database", "query", "sql", "persistence"],
    "cloud & devops": ["cloud", "deploy", "ci/cd", "pipeline", "infrastructure"],
    "ai & machine learning": ["ai", "machine learning", "model", "chatbot", "data"],
    "testing & monitoring": ["test", "monitor", "quality", "automation", "ci/cd"],
  };
  const terms = termsByCategory[skill.category.toLowerCase()] ?? [];
  const ranked = bullets.map((paragraph, index) => ({
    paragraph,
    index,
    score: terms.reduce((score, term) => score + (matchesPhrase(paragraph.text, term) ? 1 : 0), 0),
  })).sort((left, right) => right.score - left.score || left.index - right.index);
  return ranked[0].paragraph;
}

function addImportantSkillExperience(
  skill: VerifiedSkill,
  requirement: Requirement,
  paragraphs: ResumeParagraph[],
  changesByTarget: Map<string, ChangeRecord>,
): ChangeRecord | undefined {
  if (skill.category.toLowerCase() === "core competencies") return undefined;
  const anchor = importantSkillAnchor(paragraphs, skill);
  if (!anchor) return undefined;
  const skillSlug = skill.canonical.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const change: ChangeRecord = {
    id: `change-important-skill-${skillSlug}`,
    action: "add",
    matchType: "new-experience-line",
    status: "proposed",
    afterParagraphId: anchor.id,
    section: anchor.section,
    role: anchor.role,
    proposedText: importantSkillExperienceText(skill),
    requirements: [requirement.canonical],
    profileFactId: `verified-skill:${skill.canonical}`,
    userConfirmed: skill.userConfirmed === true,
    source: "User-authorized required skill from the submitted job description.",
  };
  changesByTarget.set(`important-skill-experience:${skillSlug}`, change);
  return change;
}

function discoverSkillsFromCategorizedLines(jobDescription: string, requirements: Requirement[], profileSkills: VerifiedSkill[]): VerifiedSkill[] {
  const skillHeadings = /^(?:backend|frontend|sql\s*\/\s*databases?|api integration|git|data|data pipelines|python|power bi|infrastructure|must-have skills|technical skills|tools)\s*:/i;
  const candidates = new Map<string, VerifiedSkill>();
  for (const line of jobDescription.split(/\r?\n/)) {
    const heading = line.match(skillHeadings);
    if (!heading) continue;
    const body = line.slice(heading[0].length);
    const items = body.split(/[,;]|\band\b|\bor\b|\bfor\b/i);
    for (const rawItem of items) {
      let candidate = rawItem.trim().replace(/^[-•*\s]+|[.!?:]+$/g, "");
      candidate = candidate
        .replace(/^(?:strong|basic|working|hands-on)\s+/i, "")
        .replace(/^(?:experience|knowledge|proficiency|familiarity)\s+(?:with|in|of)\s+/i, "")
        .replace(/\s+(?:experience|knowledge|skills?)\s*$/i, "")
        .replace(/\s+is a plus$/i, "")
        .trim();
      if (!candidate || candidate.length > 48 || candidate.split(/\s+/).length > 5 ||
          /^(?:ability|documentation|independently|similar|tools?|or|with|to|in|of|for)\b/i.test(candidate)) continue;
      if (requirements.some((requirement) => matchingAliases(candidate, requirement).length > 0)) continue;
      if (profileSkills.some((skill) => [skill.canonical, ...skill.aliases].some((alias) => matchesPhrase(candidate, alias)))) continue;
      const normalized = candidate.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (!normalized || candidates.has(normalized)) continue;
      candidates.set(normalized, {
        canonical: candidate,
        aliases: [candidate],
        verified: true,
        userConfirmed: true,
        category: "Tools & Platforms",
        source: "Automatically learned from a job description the user authorized as experience-matched.",
      });
    }
  }
  return [...candidates.values()];
}

function discoverCoreCompetencies(jobDescription: string, requirements: Requirement[], profileSkills: VerifiedSkill[]): VerifiedSkill[] {
  const lines = jobDescription.split(/\r?\n/);
  let inCompetencies = false;
  const discovered = new Map<string, VerifiedSkill>();
  const overviewText = jobDescription.match(/role overview\s*([\s\S]*?)(?=must[- ]have skills|$)/i)?.[1] ?? "";
  const overviewPoint = overviewText.match(/comfortable working with\s+([^.!?]+)/i)?.[1]?.trim();
  if (overviewPoint) {
    const canonical = overviewPoint.replace(/\s+and\s+/i, ", and ");
    const normalized = canonical.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!profileSkills.some((skill) => [skill.canonical, ...skill.aliases].some((alias) => alias.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === normalized))) {
      discovered.set(normalized, {
        canonical,
        aliases: [canonical, overviewPoint],
        verified: true,
        userConfirmed: true,
        category: "Core Competencies",
        source: "Automatically included because the user authorized this job description as experience-matched.",
      });
    }
  }
  for (const match of jobDescription.matchAll(/\bability to\s+([^.!?\n]+)/gi)) {
    const canonical = match[1].trim().replace(/[;,]+$/, "");
    const normalized = canonical.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!canonical || profileSkills.some((skill) => [skill.canonical, ...skill.aliases].some((alias) => alias.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === normalized))) continue;
    discovered.set(normalized, {
      canonical,
      aliases: [canonical, `Ability to ${canonical}`],
      verified: true,
      userConfirmed: true,
      category: "Core Competencies",
      source: "Automatically included because the user authorized this job description as experience-matched.",
    });
  }
  for (const line of lines) {
    if (/^\s*(?:what we(?:'|’)re looking for|qualifications|core competencies)\s*:?\s*$/i.test(line)) {
      inCompetencies = true;
      continue;
    }
    if (!inCompetencies || !line.trim()) continue;
    if (/^\s*(?:about the job|about us|about the company|role overview|must[- ]have skills|responsibilities|requirements|benefits|compensation|how to apply|equal opportunity|preferred qualifications|qualifications|what you bring|who you are|what we offer|application process|job details)\s*:?\s*$/i.test(line) ||
        /^\s*[A-Z][A-Za-z0-9 &/()-]{1,36}:\s*$/.test(line)) {
      inCompetencies = false;
      continue;
    }
    const sentence = line.replace(/^\s*[-•*]\s*/, "").trim();
    if (!sentence) continue;
    const display = sentence
      .replace(/[.!?]+$/, "")
      .replace(/\s+is a plus$/i, "")
      .replace(/^(?:strong|clear)\s+/i, "")
      .replace(/^ability to\s+/i, "")
      .replace(/^experience with\s+/i, "")
      .trim();
    const normalizedDisplay = display.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!display || display.length > 240 || requirements.some((requirement) =>
      [requirement.canonical, ...requirement.aliases].some((term) => term.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === normalizedDisplay)
    )) continue;
    if (profileSkills.some((skill) => [skill.canonical, ...skill.aliases].some((alias) => alias.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === normalizedDisplay))) continue;
    const key = normalizedDisplay;
    if (discovered.has(key)) continue;
    discovered.set(key, {
      canonical: display,
      aliases: [...new Set([display, sentence.replace(/[.!?]+$/, "")])],
      verified: true,
      userConfirmed: true,
      category: "Core Competencies",
      source: "Automatically included because the user authorized this job description as experience-matched.",
    });
  }
  return [...discovered.values()];
}

function discoverResumeBasedCapabilities(jobDescription: string, paragraphs: ResumeParagraph[], profileSkills: VerifiedSkill[]): VerifiedSkill[] {
  const discovered: VerifiedSkill[] = [];
  const sourceSkills = paragraphs.filter((paragraph) => paragraph.section === "Technical Skills").map((paragraph) => paragraph.text).join(" ");
  if (!/\bfront(?:end|[- ]end)\b/i.test(jobDescription)) return discovered;

  // Relate a broad JD phrase to technologies already listed in the source resume.
  // Prefer the frameworks the user explicitly highlighted; include other skills only
  // when no framework is available.
  const frameworks = ["React", "Angular"].filter((skill) => matchesPhrase(sourceSkills, skill));
  const supportingSkills = ["TypeScript", "JavaScript", "HTML", "CSS"].filter((skill) => matchesPhrase(sourceSkills, skill));
  const relatedSkills = frameworks.length ? frameworks : supportingSkills;
  if (!relatedSkills.length) return discovered;
  const canonical = `Frontend development using ${relatedSkills.join(" and ")}`;
  const normalized = canonical.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (profileSkills.some((skill) => [skill.canonical, ...skill.aliases].some((alias) => alias.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === normalized))) return discovered;
  discovered.push({
    canonical,
    aliases: [...new Set([canonical, "frontend development", "frontend", "front-end development", "front end development"])],
    verified: true,
    userConfirmed: true,
    category: "Core Competencies",
    source: "Derived from a broad JD requirement and technologies already listed in the user's core resume.",
  });
  return discovered;
}

function persistLearnedSkills(profilePath: string, learnedSkills: VerifiedSkill[]): void {
  if (learnedSkills.length === 0) return;
  const lockPath = `${profilePath}.lock`;
  try {
    fs.writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx" });
  } catch {
    throw new Error(`Could not update the skill memory because ${lockPath} exists. Finish or clean up the profile update, then rerun.`);
  }
  try {
    const stored = JSON.parse(fs.readFileSync(profilePath, "utf8")) as { verifiedSkills?: VerifiedSkill[]; [key: string]: unknown };
    const existingSkills = Array.isArray(stored.verifiedSkills) ? stored.verifiedSkills : [];
    for (const learned of learnedSkills) {
      if (existingSkills.some((skill) => skill.canonical.toLowerCase() === learned.canonical.toLowerCase())) continue;
      existingSkills.push(learned);
    }
    stored.verifiedSkills = existingSkills;
    const temporaryDirectory = fs.mkdtempSync(path.join(path.dirname(profilePath), ".skill-memory-"));
    try {
      const temporaryPath = path.join(temporaryDirectory, `profile-${process.pid}.json`);
      fs.writeFileSync(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
      fs.renameSync(temporaryPath, profilePath);
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  } finally {
    try {
      if (Number(fs.readFileSync(lockPath, "utf8").trim()) === process.pid) fs.rmSync(lockPath, { force: true });
    } catch {
      // The lock may already have been removed.
    }
  }
}

function buildReport(resumePath: string, jobDescriptionPath: string, profilePath: string): Report {
  const sourceSha256 = fileSha256(resumePath);
  const profile = loadExperienceProfile(profilePath, resumePath, sourceSha256);
  const baseRequirements = loadRequirements(profile.verifiedSkills);
  const paragraphs = extractParagraphs(readDocxXml(resumePath), readDocxStylesXml(resumePath));
  const paragraphById = new Map(paragraphs.map((paragraph) => [paragraph.id, paragraph]));
  const jobDescription = fs.readFileSync(jobDescriptionPath, "utf8");
  const jobDescriptionSha256 = fileSha256(jobDescriptionPath);
  const learnedSkills = [
    ...discoverSkillsFromCategorizedLines(jobDescription, baseRequirements, profile.verifiedSkills ?? []),
    ...discoverCoreCompetencies(jobDescription, baseRequirements, profile.verifiedSkills ?? []),
    ...discoverResumeBasedCapabilities(jobDescription, paragraphs, profile.verifiedSkills ?? []),
  ];
  const requirements = loadRequirements([...(profile.verifiedSkills ?? []), ...learnedSkills]);
  const jobRequirements = requirements.map((requirement) => ({
    requirement,
    aliasesFound: matchingAliases(jobDescription, requirement),
  })).filter(({ aliasesFound }) => aliasesFound.length > 0);
  const evidenceFor = (paragraph: ResumeParagraph, requirement: Requirement) =>
    matchingAliases(paragraph.text, requirement).length > 0;
  const requirementPlans: RequirementPlan[] = [];
  const changesByTarget = new Map<string, ChangeRecord>();
  const newSkillCategoryChanges = new Map<string, ChangeRecord>();
  const categorySkillCounts = new Map<string, number>();
  const verifiedSkillsByCanonical = new Map([...(profile.verifiedSkills ?? []), ...learnedSkills]
    .filter((skill) => skill.verified)
    .map((skill) => [skill.canonical.toLowerCase(), skill]));
  const factsByRequirement = new Map<string, ExperienceFact[]>();
  for (const fact of profile.facts.filter((item) => item.verified)) {
    for (const requirement of fact.requirements) {
      const facts = factsByRequirement.get(requirement) ?? [];
      facts.push(fact);
      factsByRequirement.set(requirement, facts);
    }
  }

  for (const { requirement, aliasesFound } of jobRequirements) {
    const verifiedSkillForRequirement = verifiedSkillsByCanonical.get(requirement.canonical.toLowerCase());
    const derivedCapability = verifiedSkillForRequirement?.source?.startsWith("Derived from a broad JD requirement") === true;
    const exactExperience = paragraphs.filter((paragraph) => {
      if (!paragraph.text || !paragraph.isBullet || !["Professional Experience", "Projects"].includes(paragraph.section)) return false;
      return derivedCapability ? matchesPhrase(paragraph.text, requirement.canonical) : evidenceFor(paragraph, requirement);
    });
    const exactAnywhere = paragraphs.filter((paragraph) => paragraph.text && evidenceFor(paragraph, requirement));
    if (exactExperience.length > 0) {
      requirementPlans.push({
        canonical: requirement.canonical,
        priority: priorityFor(jobDescription, aliasesFound),
        action: "keep",
        evidenceMatchType: exactExperience.some((paragraph) => matchesPhrase(paragraph.text, requirement.canonical)) ? "canonical-term" : "dictionary-alias",
        evidenceParagraphIds: exactExperience.map((paragraph) => paragraph.id),
        reason: "The requirement is already evidenced in an experience or project bullet; do not create a duplicate claim.",
      });
      continue;
    }

    const mappedFacts = factsByRequirement.get(requirement.canonical) ?? [];
    const matchingFacts = [
      ...mappedFacts,
      ...profile.facts.filter((item) => item.verified && !mappedFacts.includes(item) &&
        (matchingAliases(item.text, requirement).length > 0 || matchingAliases(item.supplementText ?? "", requirement).length > 0)),
    ];
    if (matchingFacts.length > 1) {
      const uniqueMappings = new Set(matchingFacts.map((fact) => JSON.stringify([
        fact.targetParagraphId ?? "", fact.afterParagraphId ?? "", fact.text, fact.supplementText ?? "",
      ])));
      if (uniqueMappings.size > 1) {
        throw new Error(`Multiple verified profile facts map to ${requirement.canonical}; resolve the ambiguity in ${profilePath}.`);
      }
    }
    const fact = matchingFacts[0];
    if (!fact) {
      const verifiedSkill = verifiedSkillsByCanonical.get(requirement.canonical.toLowerCase()) ?? {
        canonical: requirement.canonical,
        aliases: requirement.aliases,
        verified: true,
        userConfirmed: true,
        category: skillCategoryFromResume(requirement, exactAnywhere),
        source: "Automatically included because the user authorized this job description as experience-matched.",
      };
      if (verifiedSkill) {
        const priority = priorityFor(jobDescription, aliasesFound);
        const importantExperience = priority === "required"
          ? addImportantSkillExperience(verifiedSkill, requirement, paragraphs, changesByTarget)
          : undefined;
        const existingSkillEvidence = exactAnywhere.find((paragraph) => paragraph.section === "Technical Skills");
        if (existingSkillEvidence) {
          requirementPlans.push({
            canonical: requirement.canonical,
            priority,
            action: importantExperience ? "add" : "keep",
            evidenceMatchType: matchesPhrase(existingSkillEvidence.text, requirement.canonical) ? "canonical-term" : "dictionary-alias",
            evidenceParagraphIds: [existingSkillEvidence.id],
            ...(importantExperience ? { changeId: importantExperience.id } : {}),
            profileFactId: `verified-skill:${verifiedSkill.canonical}`,
            reason: importantExperience
              ? "The skill is listed in Technical Skills and is required by the JD; add a contextual experience point as well."
              : "The verified skill is already listed in Technical Skills; leave it unchanged.",
          });
          continue;
        }
        const skillsParagraphs = paragraphs.filter((paragraph) =>
          paragraph.section === "Technical Skills" && paragraph.text.trim() && !isSectionHeading(paragraph.text)
        );
        const anchor = skillsParagraphs[skillsParagraphs.length - 1];
        if (!anchor) {
          requirementPlans.push({
            canonical: requirement.canonical,
            priority: priorityFor(jobDescription, aliasesFound),
            action: "unsupported",
            evidenceMatchType: "none",
            evidenceParagraphIds: [],
            profileFactId: `verified-skill:${verifiedSkill.canonical}`,
            reason: "No Technical Skills paragraph is available for appending job-aligned skills.",
          });
          continue;
        }
        const count = categorySkillCounts.get(verifiedSkill.category) ?? 0;
        const groupIndex = Math.floor(count / 3);
        categorySkillCounts.set(verifiedSkill.category, count + 1);
        const key = `${verifiedSkill.category}:${groupIndex}`;
        const currentChange = newSkillCategoryChanges.get(key);
        const sectionLabel = verifiedSkill.category === "Core Competencies" ? "Core Competencies" : `Additional ${verifiedSkill.category}`;
        const proposedText = currentChange
          ? `${currentChange.proposedText.replace(/[;,\s]+$/, "")}; ${verifiedSkill.canonical}`
          : `${sectionLabel}: ${verifiedSkill.canonical}`;
        const categorySlug = verifiedSkill.category.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        const change = currentChange ?? {
          id: `change-add-${categorySlug}-${groupIndex + 1}`,
          action: "add" as const,
          matchType: "technical-skills-section-update" as const,
          status: "proposed" as const,
          afterParagraphId: anchor.id,
          section: "Technical Skills",
          role: null,
          proposedText,
          requirements: [],
          profileFactId: `job-description-${categorySlug}`,
          userConfirmed: verifiedSkill.userConfirmed === true,
          source: verifiedSkill.source ?? "user-authorized job description",
        };
        if (currentChange) change.proposedText = proposedText;
        change.requirements.push(requirement.canonical);
        change.userConfirmed = change.userConfirmed && verifiedSkill.userConfirmed === true;
        newSkillCategoryChanges.set(key, change);
        requirementPlans.push({
          canonical: requirement.canonical,
          priority,
          action: "add",
          evidenceMatchType: "verified-profile-fact",
          evidenceParagraphIds: [],
          changeId: change.id,
          profileFactId: `verified-skill:${verifiedSkill.canonical}`,
          userConfirmed: verifiedSkill.userConfirmed === true,
          reason: importantExperience
            ? "Append this required skill to Technical Skills and add a contextual experience point without replacing existing content."
            : "Append this JD-aligned point to the tailored copy without replacing existing skills.",
        });
        continue;
      }
      if (exactAnywhere.length > 0) {
        requirementPlans.push({
          canonical: requirement.canonical,
          priority: priorityFor(jobDescription, aliasesFound),
          action: "keep",
          evidenceMatchType: exactAnywhere.some((paragraph) => matchesPhrase(paragraph.text, requirement.canonical)) ? "canonical-term" : "dictionary-alias",
          evidenceParagraphIds: exactAnywhere.map((paragraph) => paragraph.id),
          reason: "The requirement is present outside experience bullets; do not claim it as new work experience.",
        });
      } else {
        requirementPlans.push({
          canonical: requirement.canonical,
          priority: priorityFor(jobDescription, aliasesFound),
          action: "unsupported",
          evidenceMatchType: "none",
          evidenceParagraphIds: [],
          reason: "No exact or user-verified fact is available. No claim was generated.",
        });
      }
      continue;
    }

    if (!matchingAliases(fact.text, requirement).length) {
      throw new Error(`Verified profile fact ${fact.id} is mapped to ${requirement.canonical}, but its proposed text contains no configured term or alias for that requirement.`);
    }

    if (fact.targetParagraphId) {
      const target = paragraphById.get(fact.targetParagraphId);
      if (!target) throw new Error(`Profile fact ${fact.id} targets missing paragraph ${fact.targetParagraphId}.`);
      const isExperienceBullet = target.isBullet && ["Professional Experience", "Projects"].includes(target.section);
      const isSkillsLine = !target.isBullet && target.section === "Technical Skills" && target.text.trim() && !isSectionHeading(target.text);
      if (!isExperienceBullet && !isSkillsLine) {
        throw new Error(`Profile fact ${fact.id} must target an experience/project bullet or a Technical Skills line; ${target.id} is in ${target.section}.`);
      }
      if (isExperienceBullet && !fact.supplementText) {
        throw new Error(`Profile fact ${fact.id} targets an experience/project bullet and must provide supplementText so the addition reads as contextual experience, not a keyword list.`);
      }
      const key = `add-profile-fact:${fact.id}`;
      const existingChange = changesByTarget.get(key);
      if (fact.supplementText && !matchingAliases(fact.supplementText, requirement).length) {
        throw new Error(`Supplement text for profile fact ${fact.id} does not include ${requirement.canonical}.`);
      }
      const requirementsForChange = [...new Set([...(existingChange?.requirements ?? []), requirement.canonical])];
      const proposedText = fact.supplementText ?? `Additional skills: ${requirementsForChange.join(", ")}.`;
      const change = existingChange ?? {
        id: `change-add-profile-fact-${target.id}`,
        action: "add" as const,
        matchType: isExperienceBullet ? "new-experience-line" as const : "technical-skills-section-update" as const,
        status: "proposed" as const,
        afterParagraphId: target.id,
        section: target.section,
        role: target.role,
        proposedText,
        requirements: [],
        profileFactId: fact.id,
        userConfirmed: fact.userConfirmed === true,
        source: fact.source ?? "verified experience profile",
      };
      if (!existingChange) changesByTarget.set(key, change);
      change.proposedText = proposedText;
      change.requirements.push(requirement.canonical);
      requirementPlans.push({
        canonical: requirement.canonical,
        priority: priorityFor(jobDescription, aliasesFound),
        action: "add",
        evidenceMatchType: "verified-profile-fact",
        evidenceParagraphIds: [],
        changeId: change.id,
        profileFactId: fact.id,
        userConfirmed: fact.userConfirmed === true,
        reason: "Append a JD-aligned point after the related source paragraph while preserving the original text.",
      });
      continue;
    }

    if (fact.afterParagraphId) {
      const anchor = paragraphById.get(fact.afterParagraphId);
      if (!anchor || !anchor.isBullet || !["Professional Experience", "Projects"].includes(anchor.section)) {
        throw new Error(`Profile fact ${fact.id} must anchor after an existing experience or project bullet.`);
      }
      const key = `add:${fact.id}`;
      const change = changesByTarget.get(key) ?? {
        id: `change-${fact.id}`,
        action: "add" as const,
        matchType: "new-experience-line" as const,
        status: "proposed" as const,
        afterParagraphId: anchor.id,
        section: anchor.section,
        role: anchor.role,
        proposedText: fact.text,
        requirements: [],
        profileFactId: fact.id,
        userConfirmed: fact.userConfirmed === true,
        source: fact.source ?? "verified experience profile",
      };
      changesByTarget.set(key, change);
      change.requirements.push(requirement.canonical);
      requirementPlans.push({
        canonical: requirement.canonical,
        priority: priorityFor(jobDescription, aliasesFound),
        action: "add",
        evidenceMatchType: "verified-profile-fact",
        evidenceParagraphIds: [],
        changeId: change.id,
        profileFactId: fact.id,
        userConfirmed: fact.userConfirmed === true,
        reason: "A verified experience fact has no matching line and is proposed as a new bullet under its recorded role.",
      });
      continue;
    }

    requirementPlans.push({
      canonical: requirement.canonical,
      priority: priorityFor(jobDescription, aliasesFound),
      action: "unsupported",
      evidenceMatchType: "none",
      evidenceParagraphIds: [],
      profileFactId: fact.id,
      reason: "The verified fact has no edit or insertion anchor; no claim was generated.",
    });
  }

  const changes = [...changesByTarget.values(), ...newSkillCategoryChanges.values()];
  const applyAdditions = changes.map((change) => {
    const sourceParagraph = change.sourceParagraphId ? paragraphById.get(change.sourceParagraphId) : undefined;
    return {
      id: change.id,
      operation: change.action === "add"
        ? change.matchType === "technical-skills-section-update" ? "add-paragraph" : "add-bullet"
        : sourceParagraph?.isBullet ? "replace-bullet" : "replace-paragraph",
      ...(change.action === "add" ? { afterParagraphId: change.afterParagraphId } : { targetParagraphId: change.sourceParagraphId }),
      text: change.proposedText,
      source: `experience-profile:${change.profileFactId}`,
      userConfirmed: change.userConfirmed,
    };
  });
  const userConfirmedRequirements = [...new Set(requirementPlans.map((plan) => plan.canonical))];
  const unsupportedRequirements = requirementPlans
    .filter((item) => item.action === "unsupported")
    .map((item) => item.canonical);
  persistLearnedSkills(profilePath, learnedSkills);

  return {
    schemaVersion: 1,
    mode: "deterministic-no-ai",
    resume: path.relative(PROJECT_ROOT, resumePath),
    jobDescription: path.relative(PROJECT_ROOT, jobDescriptionPath),
    experienceProfile: path.relative(PROJECT_ROOT, profilePath),
    sourceSha256,
    jobDescriptionSha256,
    requirements: requirementPlans,
    changes,
    unsupportedRequirements,
    learnedSkills: learnedSkills.map((skill) => skill.canonical),
    manualReview: [
      "No AI model was called. Submitting a job description is your authorization to include its parsed requirements because you apply only to roles that match your experience.",
      "Existing experience bullets and core skill lines stay unchanged. Matched experience facts become supplemental bullets; missing skills and qualifications are appended as add-on lines.",
      "Required technical skills not yet shown in an experience bullet also receive a contextual add-on bullet; preferred-only skills remain in Technical Skills.",
      "New terms found in categorized skill lists and points under What We’re Looking For are saved to your experience profile for future tailoring runs.",
      "The original DOCX is preserved. The change record identifies every added line for the future diff UI.",
      "No metrics, dates, employers, or outcomes are invented. The deterministic parser covers recognized skill categories and qualification sections; arbitrary unstructured JD wording may need parser support to be captured.",
    ],
    applyManifest: {
      sourceResume: path.relative(PROJECT_ROOT, resumePath),
      sourceSha256,
      experienceProfile: path.relative(PROJECT_ROOT, profilePath),
      userConfirmedRequirements,
      additions: applyAdditions,
    },
  };
}

function toMarkdown(report: Report): string {
  const lines = [
    "# Deterministic Tailoring Change Plan",
    "",
    `Mode: ${report.mode}`,
    `Resume: ${report.resume}`,
    `Job description: ${report.jobDescription}`,
    `Experience profile: ${report.experienceProfile}`,
    "",
    "## Change records",
    "",
  ];
  if (report.changes.length === 0) lines.push("No resume lines need changes.", "");
  for (const change of report.changes) {
    lines.push(
      `### ${change.id} — ${change.action}`,
      `- Status: ${change.status}`,
      `- Match type: ${change.matchType}`,
      `- Section and role: ${change.section}; ${change.role ?? "not identified"}`,
      `- Requirements: ${change.requirements.join(", ")}`,
      `- Profile fact: ${change.profileFactId}`,
      `- User-authorized: ${change.userConfirmed ? "yes" : "no"}`,
      ...(change.sourceParagraphId ? [`- Source paragraph: ${change.sourceParagraphId}`, `- Original: ${change.originalText}`] : [`- Insert after: ${change.afterParagraphId}`]),
      `- Proposed: ${change.proposedText}`,
      ""
    );
  }
  lines.push("## Requirement decisions", "", "| Requirement | Priority | Action | Match type | Evidence paragraph(s) | Reason |", "| --- | --- | --- | --- | --- | --- |");
  for (const requirement of report.requirements) {
    lines.push(`| ${requirement.canonical} | ${requirement.priority} | ${requirement.action} | ${requirement.evidenceMatchType} | ${requirement.evidenceParagraphIds.join(", ") || "—"} | ${requirement.reason.replace(/\|/g, "\\|")} |`);
  }
  lines.push("", "## Unsupported requirements", "");
  lines.push(...(report.unsupportedRequirements.length ? report.unsupportedRequirements.map((item) => `- ${item}`) : ["None"]));
  lines.push("", "## Learned from this job description", "");
  lines.push(...(report.learnedSkills.length ? report.learnedSkills.map((item) => `- ${item}`) : ["No new terms learned"]));
  lines.push("", "## Manual review", "");
  for (const item of report.manualReview) lines.push(`- ${item}`);
  lines.push("", "The original DOCX is not modified by the planning command.", "");
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.resume)) throw new Error(`Resume DOCX not found: ${args.resume}`);
  if (!fs.existsSync(args.jobDescription)) throw new Error(`Job description not found: ${args.jobDescription}`);
  if (!fs.existsSync(args.experienceProfile)) {
    throw new Error(`Experience profile not found: ${args.experienceProfile}. Copy Data/input/experience-profile.example.json to create one.`);
  }

  fs.mkdirSync(args.output, { recursive: true });
  const report = buildReport(args.resume, args.jobDescription, args.experienceProfile);
  const jsonPath = path.join(args.output, "tailoring-proposal.json");
  const markdownPath = path.join(args.output, "tailoring-proposal.md");
  const changesPath = path.join(args.output, "tailoring-changes.json");
  const applyManifestPath = path.join(args.output, "tailoring-apply-manifest.json");
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(markdownPath, toMarkdown(report), "utf8");
  fs.writeFileSync(changesPath, `${JSON.stringify({
    schemaVersion: report.schemaVersion,
    run: {
      mode: report.mode,
      resume: report.resume,
      jobDescription: report.jobDescription,
      experienceProfile: report.experienceProfile,
      sourceSha256: report.sourceSha256,
      jobDescriptionSha256: report.jobDescriptionSha256,
      createdAt: new Date().toISOString(),
    },
    requirements: report.requirements,
    changes: report.changes,
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(applyManifestPath, `${JSON.stringify(report.applyManifest, null, 2)}\n`, "utf8");

  console.log(`Requirements found: ${report.requirements.length}`);
  console.log(`Unchanged: ${report.requirements.filter((item) => item.action === "keep").length}`);
  console.log(`Rewrites proposed: ${report.changes.filter((item) => item.action === "rewrite").length}`);
  console.log(`New lines proposed: ${report.changes.filter((item) => item.action === "add").length}`);
  console.log(`Unsupported requirements: ${report.unsupportedRequirements.length}`);
  console.log(`Wrote: ${jsonPath}`);
  console.log(`Wrote: ${markdownPath}`);
  console.log(`Wrote: ${changesPath}`);
  console.log(`Wrote apply manifest: ${applyManifestPath}`);
}

main();
