import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { isBulletParagraph } from "./docxStructure";

type ApprovedChange = {
  id: string;
  operation: "add-bullet" | "add-paragraph" | "replace-bullet" | "replace-paragraph";
  afterParagraphId?: string;
  targetParagraphId?: string;
  text: string;
  source?: string;
  pageBreakBefore?: boolean;
  supersedes?: string;
  userConfirmed?: boolean;
};

type ApprovedAdditionsFile = {
  sourceResume?: string;
  sourceSha256?: string;
  additions: ApprovedChange[];
};

const PROJECT_ROOT = process.cwd();

function usage(): never {
  throw new Error(
    "Usage: npm run resume:apply -- --resume path/to/resume.docx --approved-additions path/to/approved-additions.json [--approved-additions more-changes.json] --output path/to/tailored.docx"
  );
}

function parseArgs(argv: string[]) {
  let resume: string | null = null;
  const approvedAdditions: string[] = [];
  let output: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--resume" && value) {
      resume = path.resolve(value);
      index += 1;
    } else if (arg === "--approved-additions" && value) {
      approvedAdditions.push(path.resolve(value));
      index += 1;
    } else if (arg === "--output" && value) {
      output = path.resolve(value);
      index += 1;
    } else {
      usage();
    }
  }

  if (!resume || approvedAdditions.length === 0 || !output) usage();
  if (resume === output) throw new Error("The output DOCX must be different from the source DOCX.");
  return { resume, approvedAdditions, output };
}

function readDocumentXml(resumePath: string): string {
  try {
    return execFileSync("unzip", ["-p", resumePath, "word/document.xml"], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch {
    throw new Error(`Could not read word/document.xml from ${resumePath}.`);
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function runProperties(runXml: string | undefined): string {
  return runXml?.match(/<w:rPr\b[\s\S]*?<\/w:rPr>/)?.[0] ?? "";
}

function withBold(runPropertiesXml: string): string {
  if (/<w:b\b[^>]*\bw:val="(?:0|false|off)"[^>]*\/>/i.test(runPropertiesXml)) {
    return runPropertiesXml.replace(/<w:b\b[^>]*\/>/i, "<w:b/>");
  }
  if (/<w:b\b/.test(runPropertiesXml)) return runPropertiesXml;
  return runPropertiesXml
    ? runPropertiesXml.replace("</w:rPr>", "<w:b/></w:rPr>")
    : "<w:rPr><w:b/></w:rPr>";
}

function copyParagraphFormatting(anchorXml: string, text: string, pageBreakBefore = false, boldLabel = false): string {
  let paragraphProperties = anchorXml.match(/<w:pPr\b[\s\S]*?<\/w:pPr>/)?.[0] ?? "";
  if (pageBreakBefore && !/<w:pageBreakBefore\b/.test(paragraphProperties)) {
    paragraphProperties = paragraphProperties
      ? paragraphProperties.replace("</w:pPr>", "<w:pageBreakBefore/></w:pPr>")
      : "<w:pPr><w:pageBreakBefore/></w:pPr>";
  }
  const textRuns = (anchorXml.match(/<w:r\b[\s\S]*?<\/w:r>/g) ?? [])
    .filter((run) => /<w:t\b/.test(run));
  const boldRun = textRuns.find((run) => /<w:b(?:\s|\/|>)/.test(run));
  const regularRun = textRuns.find((run) => !/<w:b(?:\s|\/|>)/.test(run));
  const regularProperties = runProperties(regularRun ?? textRuns[0]);
  const colonIndex = text.indexOf(":");
  if (boldLabel && colonIndex > 0) {
    const labelProperties = withBold(runProperties(boldRun) || regularProperties);
    const label = text.slice(0, colonIndex + 1);
    const value = text.slice(colonIndex + 1);
    return `<w:p>${paragraphProperties}<w:r>${labelProperties}<w:t xml:space="preserve">${escapeXml(label)}</w:t></w:r><w:r>${regularProperties}<w:t xml:space="preserve">${escapeXml(value)}</w:t></w:r></w:p>`;
  }
  return `<w:p>${paragraphProperties}<w:r>${regularProperties}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function loadApprovedAdditions(filePath: string): ApprovedAdditionsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new Error(`Could not parse approved additions JSON: ${filePath}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Approved additions must be a JSON object.");
  }
  const candidate = parsed as { sourceResume?: unknown; sourceSha256?: unknown; additions?: unknown };
  if (!Array.isArray(candidate.additions)) {
    throw new Error("Approved additions must contain an additions array.");
  }
  const additions = candidate.additions.map((item, index): ApprovedChange => {
    if (!item || typeof item !== "object") {
      throw new Error(`Addition ${index + 1} must be an object.`);
    }
    const addition = item as Partial<ApprovedChange>;
    if (
      typeof addition.id !== "string" ||
      (addition.operation !== "add-bullet" && addition.operation !== "add-paragraph" && addition.operation !== "replace-bullet" && addition.operation !== "replace-paragraph") ||
      typeof addition.text !== "string" ||
      addition.text.trim().length === 0
    ) {
      throw new Error(`Addition ${index + 1} requires id, operation, and non-empty text.`);
    }
    if ((addition.operation === "add-bullet" || addition.operation === "add-paragraph") && typeof addition.afterParagraphId !== "string") {
      throw new Error(`Addition ${index + 1} requires afterParagraphId for ${addition.operation}.`);
    }
    if (addition.operation !== "add-bullet" && addition.operation !== "add-paragraph" && typeof addition.targetParagraphId !== "string") {
      throw new Error(`Addition ${index + 1} requires targetParagraphId for ${addition.operation}.`);
    }
    return {
      id: addition.id,
      operation: addition.operation,
      afterParagraphId: addition.afterParagraphId,
      targetParagraphId: addition.targetParagraphId,
      text: addition.text.trim(),
      source: typeof addition.source === "string" ? addition.source : undefined,
      pageBreakBefore: addition.pageBreakBefore === true,
      supersedes: typeof addition.supersedes === "string" ? addition.supersedes : undefined,
      userConfirmed: addition.userConfirmed === true,
    };
  });
  const sourceSha256 = typeof candidate.sourceSha256 === "string" ? candidate.sourceSha256 : undefined;
  if (additions.length > 0 && (!sourceSha256 || !/^[a-f0-9]{64}$/i.test(sourceSha256))) {
    throw new Error(`Approved additions must include the 64-character sourceSha256 from the proposal before paragraph IDs can be applied: ${filePath}`);
  }
  return {
    sourceResume: typeof candidate.sourceResume === "string" ? candidate.sourceResume : undefined,
    sourceSha256,
    additions,
  };
}

function paragraphIndex(paragraphId: string): number {
  const match = paragraphId.match(/^p-(\d{4})$/);
  if (!match) throw new Error(`Invalid paragraph id: ${paragraphId}`);
  return Number(match[1]) - 1;
}

function patchDocumentXml(documentXml: string, additions: ApprovedChange[], stylesXml: string): string {
  const paragraphMatches = [...documentXml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)];
  const additionsByParagraph = new Map<number, ApprovedChange[]>();
  const replacementsByParagraph = new Map<number, ApprovedChange>();

  for (const addition of additions) {
    const isAddition = addition.operation === "add-bullet" || addition.operation === "add-paragraph";
    const anchorId = isAddition ? addition.afterParagraphId : addition.targetParagraphId;
    if (!anchorId) throw new Error(`Missing paragraph anchor for ${addition.id}`);
    const index = paragraphIndex(anchorId);
    const anchor = paragraphMatches[index]?.[0];
    if (!anchor) throw new Error(`Anchor paragraph not found for ${addition.id}: ${anchorId}`);
    if (addition.operation === "add-bullet" && !isBulletParagraph(anchor, stylesXml)) {
      throw new Error(`Anchor ${anchorId} is not a bullet paragraph; choose an experience/project bullet.`);
    }
    if (addition.operation === "replace-bullet" && !isBulletParagraph(anchor, stylesXml)) {
      throw new Error(`Anchor ${anchorId} is not a bullet paragraph; choose an experience/project bullet.`);
    }
    if (addition.operation !== "add-bullet" && addition.operation !== "add-paragraph") {
      const previous = replacementsByParagraph.get(index);
      if (previous && addition.supersedes !== previous.id) {
        throw new Error(`Multiple replacements target ${anchorId}; ${addition.id} must explicitly supersede ${previous.id}.`);
      }
      replacementsByParagraph.set(index, addition);
      continue;
    }
    const existing = additionsByParagraph.get(index) ?? [];
    existing.push(addition);
    additionsByParagraph.set(index, existing);
  }

  let patched = documentXml;
  for (let index = paragraphMatches.length - 1; index >= 0; index -= 1) {
    const replacement = replacementsByParagraph.get(index);
    const additionsAtAnchor = additionsByParagraph.get(index);
    const match = paragraphMatches[index];
    const end = (match.index ?? 0) + match[0].length;
    const replacementXml = replacement ? copyParagraphFormatting(match[0], replacement.text, replacement.pageBreakBefore) : match[0];
    const insertion = additionsAtAnchor?.length
      ? additionsAtAnchor.map((addition) => copyParagraphFormatting(match[0], addition.text, false, addition.operation === "add-paragraph")).join("")
      : "";
    if (replacement || insertion) {
      patched = `${patched.slice(0, end - match[0].length)}${replacementXml}${insertion}${patched.slice(end)}`;
    }
  }
  return patched;
}

function packageDocx(sourceResume: string, output: string, documentXml: string) {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "tailor-resume-"));
  try {
    execFileSync("unzip", ["-q", sourceResume, "-d", tempDirectory]);
    const documentXmlPath = path.join(tempDirectory, "word", "document.xml");
    fs.writeFileSync(documentXmlPath, documentXml, "utf8");
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const stagingDirectory = fs.mkdtempSync(path.join(path.dirname(output), ".tailor-output-"));
    try {
      const temporaryOutput = path.join(stagingDirectory, "tailored.docx");
      execFileSync("zip", ["-q", "-r", temporaryOutput, "."], { cwd: tempDirectory });
      execFileSync("unzip", ["-t", temporaryOutput], { stdio: "ignore" });
      fs.renameSync(temporaryOutput, output);
    } finally {
      fs.rmSync(stagingDirectory, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.resume)) throw new Error(`Resume DOCX not found: ${args.resume}`);
  for (const filePath of args.approvedAdditions) {
    if (!fs.existsSync(filePath)) throw new Error(`Approved additions file not found: ${filePath}`);
  }

  const approvedFiles = args.approvedAdditions.map(loadApprovedAdditions);
  const actualSha256 = createHash("sha256").update(fs.readFileSync(args.resume)).digest("hex");
  for (const approved of approvedFiles) {
    if (approved.sourceResume && path.resolve(PROJECT_ROOT, approved.sourceResume) !== args.resume) {
      throw new Error(`Approved additions sourceResume does not match --resume: ${approved.sourceResume}`);
    }
    if (approved.sourceSha256 && actualSha256 !== approved.sourceSha256) {
      throw new Error("Source DOCX changed since the approved paragraph IDs were recorded.");
    }
  }
  const additions = approvedFiles.flatMap((approved) => approved.additions);
  const documentXml = readDocumentXml(args.resume);
  let stylesXml = "";
  try {
    stylesXml = execFileSync("unzip", ["-p", args.resume, "word/styles.xml"], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  } catch {
    // Some minimal DOCX packages omit styles.xml; direct paragraph numbering is still recognized.
  }
  const patchedXml = patchDocumentXml(documentXml, additions, stylesXml);
  packageDocx(args.resume, args.output, patchedXml);

  console.log(`Approved changes applied: ${additions.length}`);
  console.log(`Source unchanged: ${args.resume}`);
  console.log(`Wrote tailored DOCX: ${args.output}`);
}

main();
