import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import type {
  AuditRequirement,
  RequirementSummary,
  TailoringChange,
  TailoringRunResponse,
} from "../shared/api";
import { getChatGPTAccessToken } from "./chatgptAuth";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(__dirname, "..");
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
  reportPath: string;
  downloadName: string;
  response: TailoringRunResponse;
}

function countStatus(requirements: AuditRequirement[], status: string): number {
  return requirements.filter((requirement) => requirement.status === status).length;
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
): Promise<TailoringRunFiles> {
  let chatGPTAccessToken: string;
  try {
    chatGPTAccessToken = await getChatGPTAccessToken();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/^(?:Connect ChatGPT|ChatGPT plan authorization|ChatGPT plan permission)/.test(message)) {
      throw new UserFacingTailoringError(message);
    }
    throw error;
  }
  if (!(await fs.stat(profilePath).catch(() => null))) {
    throw new UserFacingTailoringError("The local experience profile is missing. Set it up from the example profile first.");
  }

  const runId = randomUUID();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), runDirectoryPrefix));
  const inputPath = path.join(directory, "source-resume.docx");
  const jobDescriptionPath = path.join(directory, "job-description.txt");
  const outputPath = path.join(directory, "tailored-resume.docx");
  const reportPath = path.join(directory, "report");

  try {
    await fs.writeFile(path.join(directory, runOwnershipMarker), runOwnershipMarkerText, { flag: "wx", mode: 0o600 });
    await fs.writeFile(inputPath, resumeBytes, { flag: "wx", mode: 0o600 });
    await fs.writeFile(jobDescriptionPath, jobDescription, { flag: "wx", mode: 0o600 });

    let processOutput = "";
    let processError = "";
    try {
      const result = await execFileAsync(
        "npm",
        [
          "run", "resume:tailor", "--",
          "--resume", inputPath,
          "--job-description", jobDescriptionPath,
          "--experience-profile", profilePath,
          "--output", outputPath,
          "--report-dir", reportPath,
        ],
        {
          cwd: projectRoot,
          env: { ...process.env, OPENAI_API_KEY: undefined, OPENAI_ACCESS_TOKEN: chatGPTAccessToken },
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
    const [proposalMarkdown, auditMarkdown] = await Promise.all([
      fs.readFile(path.join(reportPath, "tailoring-proposal.md"), "utf8"),
      fs.readFile(path.join(reportPath, "ats-audit.md"), "utf8"),
    ]);
    const combinedReportPath = path.join(directory, "tailoring-report.md");
    await fs.writeFile(combinedReportPath, `${proposalMarkdown}\n\n---\n\n${auditMarkdown}`, { mode: 0o600 });

    const issueCount = audit.preservationIssues.length + audit.formatIssues.length;
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
      downloads: {
        resume: `/api/runs/${runId}/resume`,
        report: `/api/runs/${runId}/report`,
      },
    };

    return {
      runId,
      directory,
      resumePath: outputPath,
      reportPath: combinedReportPath,
      downloadName: `${path.parse(originalFileName).name}-tailored.docx`,
      response,
    };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
