import * as path from "path";
import * as fs from "fs";
import { execFileSync } from "child_process";
import { persistLearnedSkills } from "./tailorResume";

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

function runNpmScript(script: string, args: string[]): void {
  execFileSync("npm", ["run", script, "--", ...args], {
    cwd: process.cwd(),
    stdio: "inherit",
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sharedArgs = [
    "--resume", args.resume,
    "--job-description", args.jobDescription,
    "--experience-profile", args.experienceProfile,
  ];
  runNpmScript("resume:propose", [...sharedArgs, "--output", args.reportDirectory]);
  const manifest = path.join(args.reportDirectory, "tailoring-apply-manifest.json");
  runNpmScript("resume:apply", ["--resume", args.resume, "--approved-additions", manifest, "--output", args.output]);
  runNpmScript("resume:audit", [
    "--source", args.resume,
    "--resume", args.output,
    "--job-description", args.jobDescription,
    "--approved-additions", manifest,
    "--output", args.reportDirectory,
  ]);
  const proposal = JSON.parse(fs.readFileSync(path.join(args.reportDirectory, "tailoring-proposal.json"), "utf8")) as {
    learnedSkillRecords?: unknown;
  };
  if (!Array.isArray(proposal.learnedSkillRecords)) {
    throw new Error("The tailoring proposal did not contain a valid pending skill-memory update.");
  }
  persistLearnedSkills(args.experienceProfile, proposal.learnedSkillRecords as Parameters<typeof persistLearnedSkills>[1]);
  console.log(`Tailored resume: ${args.output}`);
  console.log(`Change record and audit: ${args.reportDirectory}`);
}

main();
