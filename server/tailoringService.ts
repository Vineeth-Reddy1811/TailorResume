import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import type {
  AuditRequirement,
  RequirementSummary,
  ResumePreviewLine,
  TailoringChange,
  TailoringRunResponse,
} from "../shared/api";
import { isBulletParagraph } from "../docxStructure";
import { getChatGPTAccessToken } from "./chatgptAuth";
import {
  loadLocalSkillCatalog,
  persistLocalSkillCandidates,
  type SkillCatalogCandidate,
  type SkillCatalogEntry,
} from "./skillCatalog";

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();
const compiledServer = __filename.endsWith(".js");
const profilePath = path.join(projectRoot, "Data", "input", "experience-profile.json");
const maxProcessingTimeMs = 5 * 60 * 1000;
export const runDirectoryPrefix = "tailor-resume-run-";
export const runOwnershipMarker = ".tailor-resume-owned";
export const runOwnershipMarkerText = "TailorResume local web app temporary run v1\n";

export class UserFacingTailoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingTailoringError";
  }
}

interface ProposalReport {
  requirements: Array<{
    requirementId: string;
    canonical: string;
    priority: "required" | "preferred";
    action: RequirementSummary["action"];
    reason: string;
    changeId?: string;
    evidenceParagraphIds?: string[];
    jobDescriptionEvidence?: string[];
  }>;
  changes: TailoringChange[];
  unsupportedRequirements: string[];
  analysisWarnings?: string[];
  skillCatalogCandidates?: SkillCatalogCandidate[];
}

interface AuditReport {
  preservationIssues: string[];
  formatIssues: string[];
  requirements: AuditRequirement[];
}

export interface TailoringRunFiles {
  runId: string;
  directory: string;
  resumePath: string;
  downloadName: string;
  response: TailoringRunResponse;
  skillCatalogCandidates: SkillCatalogCandidate[];
}

export interface TailoringExecutionOptions {
  experienceProfile?: Record<string, unknown>;
  provider?: "anthropic" | "openai";
  providerApiKey?: string;
  model?: string;
  skillCatalog?: SkillCatalogEntry[];
}

function countStatus(requirements: AuditRequirement[], status: string): number {
  return requirements.filter((requirement) => requirement.status === status).length;
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, number: string) => String.fromCodePoint(Number(number)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function paragraphIndex(paragraphId: string | undefined): number | undefined {
  const match = paragraphId?.match(/^p-(\d{4})$/);
  return match ? Number(match[1]) - 1 : undefined;
}

async function readResumePreview(resumePath: string, changes: TailoringChange[]): Promise<ResumePreviewLine[]> {
  const [document, styles] = await Promise.all([
    execFileAsync("unzip", ["-p", resumePath, "word/document.xml"], { encoding: "utf8", maxBuffer: 25 * 1024 * 1024 }),
    execFileAsync("unzip", ["-p", resumePath, "word/styles.xml"], { encoding: "utf8", maxBuffer: 5 * 1024 * 1024 }).catch(() => ({ stdout: "", stderr: "" })),
  ]);
  const documentXml = document.stdout;
  const insertions = changes.flatMap((change) => {
    if (change.action !== "add") return [];
    const anchor = paragraphIndex(change.afterParagraphId);
    return anchor === undefined ? [] : [{ anchor }];
  });
  const insertionsBefore = (index: number) => insertions.filter((item) => item.anchor < index).length;
  const changedParagraphs = new Set<number>();
  changes.forEach((change) => {
    if (change.action !== "rewrite") return;
    const sourceIndex = paragraphIndex(change.sourceParagraphId);
    if (sourceIndex !== undefined) changedParagraphs.add(sourceIndex + insertionsBefore(sourceIndex));
  });
  insertions.forEach(({ anchor }, insertionIndex) => {
    const earlierAtAnchor = insertions.slice(0, insertionIndex).filter((item) => item.anchor === anchor).length;
    changedParagraphs.add(anchor + insertionsBefore(anchor) + earlierAtAnchor + 1);
  });
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
  let section = "Header";
  const paragraphs = documentXml.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? [];
  return paragraphs.flatMap((paragraphXml, paragraphIndex): ResumePreviewLine[] => {
    const text = [...paragraphXml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g)]
      .map((match) => match[1] === undefined ? " " : decodeXml(match[1]))
      .join("").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
    if (!text) return [];
    const heading = sectionHeadings[text.replace(/[:：]+$/, "").trim().toUpperCase()];
    if (heading) {
      section = heading;
      return [{ text, section, kind: "section-heading", changed: false }];
    }
    const isBullet = isBulletParagraph(paragraphXml, styles.stdout);
    return [{ text, section, kind: isBullet ? "bullet" : "paragraph", changed: changedParagraphs.has(paragraphIndex) }];
  });
}

function extractCliFailure(logs: string): string | undefined {
  const candidates = logs
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^at\s/.test(line) && !/^>\s/.test(line) &&
      !/^Error: Command failed:/.test(line) && !/^npm (?:error|notice)\b/i.test(line) &&
      !/^Node\.js v\d/.test(line) && !line.includes("node_modules/"));
  const profileLockFailure = candidates.some((line) => /^Could not update the skill memory because .*\.lock exists\./i.test(line));
  if (profileLockFailure) return "Could not update the saved skill profile because an update lock is present. Resolve the existing profile update before retrying.";

  const safeError = candidates.find((line) =>
    /^Claude (?:declined|did not|returned|rate limited|tailoring request failed|response)/i.test(line) ||
    /^OpenAI API (?:key was rejected|rate limited|tailoring request failed|did not|returned)\b/i.test(line) ||
    /^OpenAI (?:did not|returned|proposed|selected)\b/i.test(line) ||
    /^OpenAI declined\b/i.test(line) ||
    /^OpenAI's proposed\b/i.test(line) ||
    /^ChatGPT plan (?:access token is missing|request failed with HTTP)\b/i.test(line) ||
    /^ChatGPT did not (?:return|complete)\b/i.test(line) ||
    /^Resume processing stopped before all output files were created\./i.test(line)
  );
  return safeError?.slice(0, 500);
}

export async function createTailoringRun(
  resumeBytes: Buffer,
  originalFileName: string,
  jobDescription: string,
  options: TailoringExecutionOptions = {},
): Promise<TailoringRunFiles> {
  let chatGPTAccessToken: string | undefined;
  if (!options.provider) {
    try {
      chatGPTAccessToken = await getChatGPTAccessToken();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/^(?:Connect ChatGPT|ChatGPT plan authorization|ChatGPT plan permission)/.test(message)) {
        throw new UserFacingTailoringError(message);
      }
      throw error;
    }
  }
  if (!options.experienceProfile && !(await fs.stat(profilePath).catch(() => null))) {
    throw new UserFacingTailoringError("The local experience profile is missing. Set it up from the example profile first.");
  }

  const runId = randomUUID();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), runDirectoryPrefix));
  const inputPath = path.join(directory, "source-resume.docx");
  const jobDescriptionPath = path.join(directory, "job-description.txt");
  const outputPath = path.join(directory, "tailored-resume.docx");
  const reportPath = path.join(directory, "report");
  const runProfilePath = options.experienceProfile ? path.join(directory, "experience-profile.json") : profilePath;
  const runSkillDictionaryPath = path.join(directory, "skill-dictionary.json");

  try {
    await fs.writeFile(path.join(directory, runOwnershipMarker), runOwnershipMarkerText, { flag: "wx", mode: 0o600 });
    await fs.writeFile(inputPath, resumeBytes, { flag: "wx", mode: 0o600 });
    await fs.writeFile(jobDescriptionPath, jobDescription, { flag: "wx", mode: 0o600 });
    if (options.experienceProfile) {
      await fs.writeFile(runProfilePath, `${JSON.stringify(options.experienceProfile, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    }
    let skillCatalog: SkillCatalogEntry[];
    try {
      skillCatalog = options.skillCatalog ?? await loadLocalSkillCatalog();
    } catch (error) {
      throw new UserFacingTailoringError(error instanceof Error ? error.message : "The local skill catalog could not be loaded.");
    }
    await fs.writeFile(runSkillDictionaryPath, `${JSON.stringify(skillCatalog, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    if (options.provider && (!options.providerApiKey || !options.model)) {
      throw new UserFacingTailoringError("The selected AI provider connection is incomplete. Update its key and model in account settings.");
    }

    let processOutput = "";
    let processError = "";
    try {
      const runner = compiledServer
        ? [path.join(projectRoot, "build", "tailorAndApply.js")]
        : [
          path.join(projectRoot, "node_modules", "ts-node", "dist", "bin.js"),
          path.join(projectRoot, "tailorAndApply.ts"),
        ];
      const result = await execFileAsync(
        process.execPath,
        [
          ...runner,
          "--resume", inputPath,
          "--job-description", jobDescriptionPath,
          "--experience-profile", runProfilePath,
          "--output", outputPath,
          "--report-dir", reportPath,
        ],
        {
          cwd: projectRoot,
          env: {
            ...process.env,
            OPENAI_API_KEY: undefined,
            OPENAI_ACCESS_TOKEN: options.provider ? undefined : chatGPTAccessToken,
            TAILORRESUME_AI_PROVIDER: options.provider ?? "chatgpt",
            TAILORRESUME_AI_API_KEY: options.providerApiKey,
            TAILORRESUME_AI_MODEL: options.model,
            TAILORRESUME_SKILL_DICTIONARY: runSkillDictionaryPath,
            TAILORRESUME_CATALOG_MANAGED_BY_SERVER: "true",
          },
          timeout: maxProcessingTimeMs,
          maxBuffer: 5 * 1024 * 1024,
          encoding: "utf8",
        },
      );
      processOutput = result.stdout;
      processError = result.stderr;
    } catch (error) {
      const childError = error as Error & { stdout?: string; stderr?: string };
      processOutput = childError.stdout ?? "";
      processError = childError.stderr ?? childError.message;
    }

    const tailoredExists = await fs.stat(outputPath).then(() => true, () => false);
    const proposalPath = path.join(reportPath, "tailoring-proposal.json");
    const auditPath = path.join(reportPath, "ats-audit.json");
    const [proposalExists, auditExists] = await Promise.all([
      fs.stat(proposalPath).then(() => true, () => false),
      fs.stat(auditPath).then(() => true, () => false),
    ]);

    if (!tailoredExists || !proposalExists || !auditExists) {
      console.error("Resume tailoring process did not produce all expected files.", processError, processOutput);
      const childLogs = `${processError}\n${processOutput}`;
      if (childLogs.includes("sourceResume does not match") || childLogs.includes("Source DOCX changed")) {
        throw new UserFacingTailoringError("The experience profile is linked to a different resume. Upload its matching DOCX or update the profile hash after checking its paragraph anchors.");
      }
      const openAiFailure = childLogs.split(/\r?\n/).map((line) => line.trim()).find((line) =>
        /ChatGPT plan access token is missing\./.test(line) ||
        /ChatGPT plan request failed with HTTP \d{3}(?: \([a-z0-9_]+\))?/.test(line) ||
        /Connect ChatGPT and allow ChatGPT plan usage/.test(line)
      );
      if (openAiFailure) throw new UserFacingTailoringError(openAiFailure.replace(/^Error:\s*/, ""));
      const cliFailure = extractCliFailure(processError) ?? extractCliFailure(processOutput);
      if (cliFailure) throw new UserFacingTailoringError(cliFailure.replace(/^Error:\s*/, ""));
      throw new UserFacingTailoringError("Resume processing stopped before all output files were created. Check the local server log for details and try again.");
    }

    const [proposal, audit] = await Promise.all([
      fs.readFile(proposalPath, "utf8").then((text) => JSON.parse(text) as ProposalReport),
      fs.readFile(auditPath, "utf8").then((text) => JSON.parse(text) as AuditReport),
    ]);
    const issueCount = audit.preservationIssues.length + audit.formatIssues.length;
    const skillCatalogCandidates = Array.isArray(proposal.skillCatalogCandidates) ? proposal.skillCatalogCandidates : [];
    const preview = await readResumePreview(outputPath, proposal.changes);
    const response: TailoringRunResponse = {
      runId,
      originalFileName: path.basename(originalFileName),
      counts: {
        requirements: proposal.requirements.length,
        unchanged: proposal.requirements.filter((item) => item.action === "keep").length,
        additions: proposal.changes.filter((change) => change.action === "add").length,
        rewrites: proposal.changes.filter((change) => change.action === "rewrite").length,
        unsupported: proposal.unsupportedRequirements.length,
        experienceEvidence: countStatus(audit.requirements, "experience evidence"),
        userConfirmedEvidence: countStatus(audit.requirements, "user-confirmed evidence"),
        partialEvidence: countStatus(audit.requirements, "partial evidence"),
        missingEvidence: countStatus(audit.requirements, "no evidence"),
        unverifiedEvidence: countStatus(audit.requirements, "unverified wording"),
        documentIssues: issueCount,
      },
      requirements: proposal.requirements,
      unsupportedRequirements: proposal.unsupportedRequirements,
      changes: proposal.changes,
      auditRequirements: audit.requirements,
      documentChecks: {
        preservationIssues: audit.preservationIssues,
        formatIssues: audit.formatIssues,
      },
      warnings: [...(proposal.analysisWarnings ?? []), ...audit.preservationIssues, ...audit.formatIssues],
      preview,
      downloads: {
        resume: `/api/runs/${runId}/resume`,
      },
    };

    if (!isHostedProcess()) {
      try {
        const saved = await persistLocalSkillCandidates(skillCatalogCandidates);
        if (saved.pending) response.warnings.push(`${saved.pending} newly detected skill term${saved.pending === 1 ? " is" : "s are"} queued for review before future matching.`);
      } catch {
        response.warnings.push("New skill terms could not be saved to the local catalog and may be rediscovered next time.");
      }
    }
    return {
      runId,
      directory,
      resumePath: outputPath,
      downloadName: `${path.parse(originalFileName).name}-tailored.docx`,
      response,
      skillCatalogCandidates,
    };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function isHostedProcess(): boolean {
  return process.env.APP_MODE === "hosted";
}
