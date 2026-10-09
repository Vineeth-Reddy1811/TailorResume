import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { execFileSync } from "child_process";

type Change = {
  id: string;
  operation: "add-bullet" | "add-paragraph" | "replace-bullet" | "replace-paragraph";
  afterParagraphId?: string;
  targetParagraphId?: string;
  text: string;
  supersedes?: string;
  userConfirmed?: boolean;
};

type Paragraph = { id: string; section: string; text: string; isBullet: boolean };
type Requirement = { canonical: string; aliases: string[] };
type MatchStatus = "experience evidence" | "partial evidence" | "user-confirmed evidence" | "no evidence" | "unverified wording";

const root = process.cwd();
const dictionaryPath = path.join(root, "config", "skill-dictionary.json");
const experienceProfilePath = path.join(root, "Data", "input", "experience-profile.json");
const sectionHeadings: Record<string, string> = {
  SUMMARY: "Summary",
  EXPERIENCE: "Experience",
  "PROFESSIONAL EXPERIENCE": "Experience",
  SKILLS: "Skills",
  "TECHNICAL SKILLS": "Skills",
  "TECHNICAL KNOWLEDGE": "Skills",
  PROJECTS: "Projects",
  EDUCATION: "Education",
  CERTIFICATIONS: "Certifications",
};

function usage(): never {
  throw new Error("Usage: npm run resume:audit -- --source original.docx --resume tailored.docx --job-description job.txt --approved-additions changes.json [--approved-additions more.json] --output report-directory");
}

function parseArgs(argv: string[]) {
  const args: { source?: string; resume?: string; jobDescription?: string; output?: string; approvedAdditions: string[] } = { approvedAdditions: [] };
  for (let index = 0; index < argv.length; index += 2) {
    const value = argv[index + 1];
    if (!value) usage();
    if (argv[index] === "--source") args.source = path.resolve(value);
    else if (argv[index] === "--resume") args.resume = path.resolve(value);
    else if (argv[index] === "--job-description") args.jobDescription = path.resolve(value);
    else if (argv[index] === "--output") args.output = path.resolve(value);
    else if (argv[index] === "--approved-additions") args.approvedAdditions.push(path.resolve(value));
    else usage();
  }
  if (!args.source || !args.resume || !args.jobDescription || !args.output || !args.approvedAdditions.length) usage();
  return args as { source: string; resume: string; jobDescription: string; output: string; approvedAdditions: string[] };
}

function zipMemberBuffer(filePath: string, member: string): Buffer {
  const literalMember = member.replace(/[\[\]*?]/g, (character) => `\\${character}`);
  return execFileSync("unzip", ["-p", filePath, literalMember], { maxBuffer: 25 * 1024 * 1024 });
}

function zipMember(filePath: string, member: string): string {
  return zipMemberBuffer(filePath, member).toString("utf8");
}

function zipMembers(filePath: string): string[] {
  return execFileSync("unzip", ["-Z1", filePath], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
}

function decodeXml(value: string): string {
  return value.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, number: string) => String.fromCodePoint(Number(number)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function textFromParagraph(xml: string): string {
  const pieces: string[] = [];
  for (const match of xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g)) {
    pieces.push(match[1] === undefined ? " " : decodeXml(match[1]));
  }
  return pieces.join("").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function paragraphsFromXml(xml: string): Paragraph[] {
  let section = "Header";
  return (xml.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? []).map((raw, index) => {
    const text = textFromParagraph(raw);
    const heading = sectionHeadings[text.replace(/[:：]+$/, "").trim().toUpperCase()];
    if (heading) section = heading;
    return {
      id: `p-${String(index + 1).padStart(4, "0")}`,
      section,
      text,
      isBullet: /<w:numPr\b/.test(raw) || /<w:pStyle\b[^>]*\bw:val="List(?:Paragraph|Bullet|Number)/.test(raw),
    };
  });
}

function normalize(value: string): string {
  return value.toLowerCase()
    .replace(/c\+\+/g, " cpp ")
    .replace(/c#/g, " csharp ")
    .replace(/f#/g, " fsharp ")
    .replace(/\.net\b/g, " dotnet ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function containsPhrase(text: string, phrase: string): boolean {
  const needle = normalize(phrase);
  return needle.length > 0 && ` ${normalize(text)} `.includes(` ${needle} `);
}

function paragraphNumber(id: string): number {
  const match = id.match(/^p-(\d{4})$/);
  if (!match) throw new Error(`Invalid paragraph ID in approved changes: ${id}`);
  return Number(match[1]) - 1;
}

function approvedChanges(files: string[], source: string): Change[] {
  const hash = createHash("sha256").update(fs.readFileSync(source)).digest("hex");
  const changes: Change[] = [];
  for (const filePath of files) {
    const manifest = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      sourceResume?: string; sourceSha256?: string; additions?: Change[];
    };
    if (manifest.sourceResume && path.resolve(root, manifest.sourceResume) !== source) {
      throw new Error(`Approved changes refer to a different source resume: ${filePath}`);
    }
    if (manifest.sourceSha256 && manifest.sourceSha256 !== hash) {
      throw new Error(`Source hash differs from approved changes: ${filePath}`);
    }
    if (!Array.isArray(manifest.additions)) throw new Error(`Missing additions array: ${filePath}`);
    changes.push(...manifest.additions);
  }
  return changes;
}

function pendingLearnedSkills(files: string[]): Requirement[] {
  const skills = new Map<string, Requirement>();
  for (const filePath of files) {
    const manifest = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      pendingLearnedSkills?: Array<{ canonical?: unknown; aliases?: unknown; verified?: unknown }>;
    };
    for (const skill of manifest.pendingLearnedSkills ?? []) {
      if (skill.verified !== true || typeof skill.canonical !== "string" || !skill.canonical.trim()) continue;
      const canonical = skill.canonical.trim();
      const aliases = Array.isArray(skill.aliases)
        ? skill.aliases.filter((alias): alias is string => typeof alias === "string" && alias.trim().length > 0).map((alias) => alias.trim())
        : [];
      const key = normalize(canonical);
      const existing = skills.get(key);
      skills.set(key, {
        canonical,
        aliases: [...new Set([...(existing?.aliases ?? []), canonical, ...aliases])],
      });
    }
  }
  return [...skills.values()];
}

function userConfirmedRequirements(files: string[]): Set<string> {
  const confirmed = new Set<string>();
  for (const filePath of files) {
    const manifest = JSON.parse(fs.readFileSync(filePath, "utf8")) as { userConfirmedRequirements?: unknown };
    if (Array.isArray(manifest.userConfirmedRequirements)) {
      for (const requirement of manifest.userConfirmedRequirements) {
        if (typeof requirement === "string") confirmed.add(requirement);
      }
    }
  }
  return confirmed;
}

function experienceProfilePaths(files: string[]): string[] {
  const paths = new Set<string>();
  for (const filePath of files) {
    const manifest = JSON.parse(fs.readFileSync(filePath, "utf8")) as { experienceProfile?: unknown };
    if (typeof manifest.experienceProfile === "string" && manifest.experienceProfile.trim()) {
      paths.add(path.resolve(root, manifest.experienceProfile));
    }
  }
  if (!paths.size && fs.existsSync(experienceProfilePath)) paths.add(experienceProfilePath);
  return [...paths];
}

function checkPreservation(source: Paragraph[], final: Paragraph[], changes: Change[]): string[] {
  const issues: string[] = [];
  const replacements = new Map<number, Change>();
  const additions = new Map<number, Change[]>();
  for (const change of changes) {
    const isAddition = change.operation === "add-bullet" || change.operation === "add-paragraph";
    const index = paragraphNumber(isAddition ? change.afterParagraphId ?? "" : change.targetParagraphId ?? "");
    if (isAddition) {
      additions.set(index, [...(additions.get(index) ?? []), change]);
    } else {
      const previous = replacements.get(index);
      if (previous && change.supersedes !== previous.id) {
        issues.push(`Replacement ${change.id} does not explicitly supersede ${previous.id}.`);
      } else replacements.set(index, change);
    }
  }
  let finalIndex = 0;
  for (let index = 0; index < source.length; index += 1) {
    const expected = replacements.get(index)?.text ?? source[index].text;
    if (final[finalIndex]?.text !== expected) {
      issues.push(`Paragraph ${source[index].id} differs from the approved text.`);
    }
    finalIndex += 1;
    for (const added of additions.get(index) ?? []) {
      if (final[finalIndex]?.text !== added.text) issues.push(`Approved addition ${added.id} is missing or out of order.`);
      finalIndex += 1;
    }
  }
  if (finalIndex !== final.length) issues.push(`Paragraph count differs: expected ${finalIndex}, found ${final.length}.`);
  return issues;
}

function checkPackage(sourcePath: string, resumePath: string): string[] {
  const issues: string[] = [];
  const sourceMembers = zipMembers(sourcePath).filter((name) => !name.endsWith("/"));
  const finalMembers = zipMembers(resumePath).filter((name) => !name.endsWith("/"));
  for (const member of sourceMembers) {
    if (!finalMembers.includes(member)) issues.push(`DOCX member removed: ${member}`);
    else if (member !== "word/document.xml" && !zipMemberBuffer(sourcePath, member).equals(zipMemberBuffer(resumePath, member))) {
      issues.push(`DOCX member changed outside document.xml: ${member}`);
    }
  }
  for (const member of finalMembers) if (!sourceMembers.includes(member)) issues.push(`Unexpected DOCX member added: ${member}`);
  return issues;
}

function formatChecks(xml: string, paragraphs: Paragraph[], members: string[]) {
  const text = paragraphs.map((item) => item.text).filter(Boolean);
  const issues: string[] = [];
  if (/<w:tbl\b/.test(xml)) issues.push("Tables appear in the main document body.");
  if (/<w:txbxContent\b/.test(xml)) issues.push("Text boxes appear in the main document body.");
  if (/<w:drawing\b|<w:pict\b/.test(xml)) issues.push("Graphics or images appear in the main document body.");
  if (/<w:cols\b[^>]*\bw:num="(?:[2-9]|[1-9]\d+)"/.test(xml)) issues.push("A multi-column section appears in the DOCX.");
  if (members.some((item) => /^word\/(?:header|footer)\d*\.xml$/.test(item))) issues.push("The DOCX contains a header or footer; verify contact information is in the body.");
  if (!text[0] || !/\b[A-Za-z]+\s+[A-Za-z]+\b/.test(text[0])) issues.push("The first non-empty paragraph does not look like a name.");
  if (!text.slice(0, 5).some((item) => /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(item))) issues.push("No email address was found near the top of the body.");
  for (const heading of ["Summary", "Experience", "Skills", "Education"]) {
    if (!paragraphs.some((item) => item.text && sectionHeadings[item.text.toUpperCase()] === heading)) {
      issues.push(`Standard section heading missing: ${heading}.`);
    }
  }
  if (text.join(" ").length < 500) issues.push("Very little selectable document text was extracted.");
  return issues;
}

function requirementPriority(jobDescription: string, aliases: string[]): "required" | "preferred" {
  const lines = jobDescription.split(/\r?\n/);
  const relevant = lines.filter((line) => aliases.some((alias) => containsPhrase(line, alias)));
  return relevant.length > 0 && relevant.every((line) => /\b(?:is a plus|are a plus|preferred)\b/i.test(line))
    ? "preferred" : "required";
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceXml = zipMember(args.source, "word/document.xml");
  const resumeXml = zipMember(args.resume, "word/document.xml");
  const sourceParagraphs = paragraphsFromXml(sourceXml);
  const resumeParagraphs = paragraphsFromXml(resumeXml);
  const changes = approvedChanges(args.approvedAdditions, args.source);
  const confirmedRequirements = userConfirmedRequirements(args.approvedAdditions);
  const members = zipMembers(args.resume);
  const preservationIssues = [
    ...checkPackage(args.source, args.resume),
    ...checkPreservation(sourceParagraphs, resumeParagraphs, changes),
  ];
  const formatIssues = formatChecks(resumeXml, resumeParagraphs, members);
  const jobDescription = fs.readFileSync(args.jobDescription, "utf8");
  const dictionary = JSON.parse(fs.readFileSync(dictionaryPath, "utf8")) as Requirement[];
  for (const skill of pendingLearnedSkills(args.approvedAdditions)) {
    const existing = dictionary.find((item) => normalize(item.canonical) === normalize(skill.canonical));
    if (existing) existing.aliases = [...new Set([...existing.aliases, ...skill.aliases])];
    else dictionary.push(skill);
  }
  for (const profilePath of experienceProfilePaths(args.approvedAdditions)) {
    if (!fs.existsSync(profilePath)) throw new Error(`Experience profile from apply manifest not found: ${profilePath}`);
    const profile = JSON.parse(fs.readFileSync(profilePath, "utf8")) as { verifiedSkills?: Array<{ canonical: string; aliases?: string[]; verified?: boolean }> };
    for (const skill of profile.verifiedSkills ?? []) {
      if (!skill.verified || typeof skill.canonical !== "string") continue;
      const existing = dictionary.find((item) => normalize(item.canonical) === normalize(skill.canonical));
      if (existing) existing.aliases = [...new Set([...existing.aliases, skill.canonical, ...(skill.aliases ?? [])])];
      else dictionary.push({ canonical: skill.canonical, aliases: [...new Set([skill.canonical, ...(skill.aliases ?? [])])] });
    }
  }
  const evidenceFor = (paragraphs: Paragraph[], requirement: Requirement) => paragraphs.flatMap((paragraph) => {
    const matchedAliases = requirement.aliases.filter((alias) => containsPhrase(paragraph.text, alias));
    return matchedAliases.length ? [{ paragraphId: paragraph.id, section: paragraph.section, matchedAliases, text: paragraph.text }] : [];
  });
  const requirements = dictionary.flatMap((requirement) => {
    const jdAliases = requirement.aliases.filter((alias) => containsPhrase(jobDescription, alias));
    if (!jdAliases.length) return [];
    const sourceEvidence = evidenceFor(sourceParagraphs, requirement);
    const evidence = evidenceFor(resumeParagraphs, requirement);
    const sourceExperience = sourceEvidence.filter((item) => ["Experience", "Projects"].includes(item.section));
    const sourceExactExperience = sourceExperience.filter((item) => item.matchedAliases.some((alias) => jdAliases.includes(alias)));
    const exactExperience = evidence.filter((item) => ["Experience", "Projects"].includes(item.section) && item.matchedAliases.some((alias) => jdAliases.includes(alias)));
    const userConfirmed = confirmedRequirements.has(requirement.canonical) && evidence.length > 0;
    const status: MatchStatus = sourceExactExperience.length && exactExperience.length ? "experience evidence"
      : userConfirmed ? "user-confirmed evidence"
      : !sourceEvidence.length && evidence.length ? "unverified wording"
      : sourceEvidence.length && evidence.length ? "partial evidence" : "no evidence";
    return [{
      requirement: requirement.canonical,
      priority: requirementPriority(jobDescription, jdAliases),
      jobTerms: jdAliases,
      status,
      exactJobTermInTailoredExperience: exactExperience.length > 0,
      sourceEvidence,
      evidence: evidence.map((item) => ({ paragraphId: item.paragraphId, section: item.section, matchedTerms: item.matchedAliases, text: item.text })),
      userConfirmedEvidence: userConfirmed,
      note: status === "partial evidence"
        ? sourceExperience.length
          ? exactExperience.length
            ? "The exact job term appears in tailored experience, but the original uses related wording; confirm the two describe the same work."
            : "Related wording appears in source experience, but the job's exact term does not appear in tailored experience."
          : "The requirement appears outside Experience or Projects in the source; the tailored copy includes it under the user's job-description authorization."
        : status === "user-confirmed evidence" ? "This requirement appears in the tailored copy and is authorized by the user's decision to submit this experience-matched job description."
        : status === "unverified wording" ? "This term appears in the tailored copy but was not found in the source; verify the claim before using it."
        : status === "no evidence" ? "Do not add without confirming genuine experience." : "",
    }];
  });
  const report = {
    title: "Job match and resume parsing audit",
    sourceResume: path.relative(root, args.source),
    tailoredResume: path.relative(root, args.resume),
    jobDescription: path.relative(root, args.jobDescription),
    sourceSha256: createHash("sha256").update(fs.readFileSync(args.source)).digest("hex"),
    tailoredSha256: createHash("sha256").update(fs.readFileSync(args.resume)).digest("hex"),
    approvedChanges: changes.length,
    simplifiedInlineFormattingParagraphs: [...new Set(changes.filter((item) => item.operation !== "add-bullet" && item.operation !== "add-paragraph").map((item) => item.targetParagraphId))],
    preservationIssues,
    formatIssues,
    requirements,
    manualChecks: [
      "The user authorized this submitted job description as experience-matched; the app does not independently validate the claims.",
      "The audit checks the shared dictionary and skills learned into the experience profile. The deterministic parser covers recognized skill categories and qualification sections.",
      "No metrics, dates, employers, or outcomes are invented. Arbitrary unstructured JD wording may require parser support to be captured.",
      "Confirm years of experience, location, work authorization, and any application questions in the application form.",
      "No employer-specific ATS parsing, ranking, or rejection decision can be guaranteed by a local document check.",
    ],
  };
  const markdown = [
    "# Job Match and Resume Parsing Audit", "",
    `Source: ${report.sourceResume}`, `Tailored resume: ${report.tailoredResume}`,
    `Approved changes checked: ${changes.length}`, "",
    "## Document checks", "",
    `- Preservation: ${preservationIssues.length ? preservationIssues.join("; ") : "all unapproved paragraph text and all DOCX parts outside document.xml preserved"}`,
    `- Parsing format: ${formatIssues.length ? formatIssues.join("; ") : "selectable text, contact in body, standard headings, one column, no tables, text boxes, or graphics detected"}`,
    `- Approved rewrites simplify inline bold and other run formatting in ${report.simplifiedInlineFormattingParagraphs.length} paragraphs; paragraph styles and bullet numbering remain.`,
    "", "## Job requirement evidence", "",
    "| Requirement | Priority | Evidence | Exact term in experience | Paragraphs |", "| --- | --- | --- | --- | --- |",
    ...requirements.map((item) => `| ${item.requirement} | ${item.priority} | ${item.status} | ${item.exactJobTermInTailoredExperience ? "yes" : "no"} | ${item.evidence.map((evidence) => `${evidence.paragraphId} (${evidence.section})`).join(", ") || "—"} |`),
    "", "## Follow-up", "",
    ...requirements.filter((item) => item.status !== "experience evidence").map((item) => `- **${item.requirement}:** ${item.note}`),
    ...report.manualChecks.map((item) => `- ${item}`), "",
  ].join("\n");
  fs.mkdirSync(args.output, { recursive: true });
  fs.writeFileSync(path.join(args.output, "ats-audit.json"), JSON.stringify(report, null, 2) + "\n");
  fs.writeFileSync(path.join(args.output, "ats-audit.md"), markdown);
  console.log(`Document issues: ${preservationIssues.length + formatIssues.length}`);
  console.log(`Requirements: ${requirements.length}; experience evidence: ${requirements.filter((item) => item.status === "experience evidence").length}; user-confirmed: ${requirements.filter((item) => item.status === "user-confirmed evidence").length}; partial: ${requirements.filter((item) => item.status === "partial evidence").length}; missing: ${requirements.filter((item) => item.status === "no evidence").length}; unverified: ${requirements.filter((item) => item.status === "unverified wording").length}`);
  console.log(`Wrote: ${path.join(args.output, "ats-audit.md")}`);
  if (preservationIssues.length || formatIssues.length || requirements.some((item) => item.status === "unverified wording")) process.exitCode = 1;
}

main();
