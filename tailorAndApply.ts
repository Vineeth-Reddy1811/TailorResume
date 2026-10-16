import * as path from "path";
import * as fs from "fs";
import { execFileSync } from "child_process";

const PROJECT_ROOT = process.cwd();
const compiledRunner = __filename.endsWith(".js");

function usage(): never {
  throw new Error("Usage: npm run resume:tailor -- --resume resume.docx --job-description job.txt --output tailored.docx [--experience-profile profile.json] [--report-dir directory]");
}

function parseArgs(argv: string[]) {
  let resume: string | undefined;
  let jobDescription: string | undefined;
  let experienceProfile = "Data/input/experience-profile.json";
  let output: string | undefined;
  let reportDirectory: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) usage();
    if (flag === "--resume") resume = path.resolve(value);
    else if (flag === "--job-description") jobDescription = path.resolve(value);
    else if (flag === "--experience-profile") experienceProfile = path.resolve(value);
    else if (flag === "--output") output = path.resolve(value);
    else if (flag === "--report-dir") reportDirectory = path.resolve(value);
    else usage();
    index += 1;
  }
  if (!resume || !jobDescription || !output) usage();
  if (resume === output) throw new Error("The tailored DOCX output must differ from the source resume.");
  const extension = path.extname(output);
  const defaultReportName = `${path.basename(output, extension)}-report`;
  return {
    resume,
    jobDescription,
    experienceProfile: path.resolve(experienceProfile),
    output,
    reportDirectory: reportDirectory ?? path.join(path.dirname(output), defaultReportName),
  };
}

function runCli(script: "tailorResume.ts" | "applyApprovedAdditions.ts" | "atsAudit.ts", args: string[]): void {
  const scriptPath = compiledRunner
    ? path.join(PROJECT_ROOT, "build", script.replace(/\.ts$/, ".js"))
    : path.join(PROJECT_ROOT, "node_modules", "ts-node", "dist", "bin.js");
  const commandArgs = compiledRunner ? [scriptPath, ...args] : [scriptPath, path.join(PROJECT_ROOT, script), ...args];
  execFileSync(process.execPath, commandArgs, {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sharedArgs = [
    "--resume", args.resume,
    "--job-description", args.jobDescription,
    "--experience-profile", args.experienceProfile,
  ];
  runCli("tailorResume.ts", [...sharedArgs, "--output", args.reportDirectory]);
  const manifest = path.join(args.reportDirectory, "tailoring-apply-manifest.json");
  runCli("applyApprovedAdditions.ts", ["--resume", args.resume, "--approved-additions", manifest, "--output", args.output]);
  runCli("atsAudit.ts", [
    "--source", args.resume,
    "--resume", args.output,
    "--job-description", args.jobDescription,
    "--approved-additions", manifest,
    "--output", args.reportDirectory,
  ]);
  if (process.env.APP_MODE !== "hosted" && process.env.TAILORRESUME_CATALOG_MANAGED_BY_SERVER !== "true") {
    const proposal = JSON.parse(fs.readFileSync(path.join(args.reportDirectory, "tailoring-proposal.json"), "utf8")) as {
      skillCatalogCandidates?: unknown;
    };
    const { persistLocalSkillCandidates } = await import("./server/skillCatalog");
    await persistLocalSkillCandidates(Array.isArray(proposal.skillCatalogCandidates) ? proposal.skillCatalogCandidates : []);
  }
  console.log(`Tailored resume: ${args.output}`);
  console.log(`Change record and audit: ${args.reportDirectory}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
