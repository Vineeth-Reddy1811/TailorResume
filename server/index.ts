import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import type { TailoringRunResponse } from "../shared/api";
import {
  chatGPTCallbackPath,
  completeChatGPTSignIn,
  disconnectChatGPT,
  getChatGPTConnectionStatus,
  startChatGPTSignIn,
} from "./chatgptAuth";
import {
  createTailoringRun,
  runDirectoryPrefix,
  runOwnershipMarker,
  runOwnershipMarkerText,
  UserFacingTailoringError,
  type TailoringRunFiles,
} from "./tailoringService";

const host = "127.0.0.1";
const port = Number(process.env.WEB_PORT ?? 4170);
const runRetentionMs = 60 * 60 * 1000;
const uploadLimitBytes = 15 * 1024 * 1024;
const jobDescriptionCharacterLimit = 30_000;
const jobDescriptionLimitBytes = jobDescriptionCharacterLimit * 4;
const allowedOrigins = new Set([
  "http://127.0.0.1:4170",
  "http://localhost:4170",
  "http://127.0.0.1:5173",
  "http://localhost:5173",
]);

interface StoredRun extends TailoringRunFiles {
  expiresAt: number;
  cleanupTimer: NodeJS.Timeout;
}

const runs = new Map<string, StoredRun>();
const tempRoot = path.resolve(os.tmpdir());
const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: uploadLimitBytes,
    fieldSize: jobDescriptionLimitBytes,
    files: 1,
    fields: 1,
    parts: 2,
  },
  fileFilter: (_request, file, callback) => {
    if (path.extname(file.originalname).toLowerCase() !== ".docx") {
      callback(new Error("Upload a DOCX resume."));
      return;
    }
    const allowedMimeTypes = new Set([
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/zip",
      "application/octet-stream",
    ]);
    if (!allowedMimeTypes.has(file.mimetype)) {
      callback(new Error("Upload a DOCX resume."));
      return;
    }
    callback(null, true);
  },
});

app.disable("x-powered-by");
app.use((_request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'");
  response.setHeader("Cache-Control", "no-store");
  next();
});

function requireLocalBrowser(request: Request, response: Response, next: NextFunction): void {
  const origin = request.get("origin");
  const requestHost = request.hostname;
  if (
    !origin
    || !allowedOrigins.has(origin)
    || !["127.0.0.1", "localhost"].includes(requestHost)
  ) {
    response.status(403).json({ error: "This local app only accepts requests from its webpage." });
    return;
  }
  next();
}

function lookupRun(runId: string | undefined): StoredRun | undefined {
  if (!runId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
    return undefined;
  }
  return runs.get(runId);
}

function scheduleCleanup(run: TailoringRunFiles): StoredRun {
  const cleanupTimer = setTimeout(() => {
    const stored = runs.get(run.runId);
    if (stored) {
      runs.delete(run.runId);
      void fs.rm(stored.directory, { recursive: true, force: true });
    }
  }, runRetentionMs);
  cleanupTimer.unref();
  const stored = { ...run, expiresAt: Date.now() + runRetentionMs, cleanupTimer };
  runs.set(run.runId, stored);
  return stored;
}

async function cleanExpiredRunDirectories(): Promise<void> {
  const entries = await fs.readdir(tempRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(runDirectoryPrefix)) continue;

    const candidate = path.join(tempRoot, entry.name);
    if (path.dirname(candidate) !== tempRoot) continue;
    const ownedPath = await fs.realpath(candidate).catch(() => "");
    if (!ownedPath || path.dirname(ownedPath) !== tempRoot) continue;
    const directoryStat = await fs.lstat(ownedPath).catch(() => null);
    if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) continue;
    if (typeof process.getuid === "function" && directoryStat.uid !== process.getuid()) continue;
    if (Date.now() - directoryStat.mtimeMs < runRetentionMs) continue;
    if ([...runs.values()].some((run) => path.resolve(run.directory) === ownedPath)) continue;

    const markerPath = path.join(ownedPath, runOwnershipMarker);
    const markerStat = await fs.lstat(markerPath).catch(() => null);
    if (!markerStat?.isFile() || markerStat.isSymbolicLink()) continue;
    if (typeof process.getuid === "function" && markerStat.uid !== process.getuid()) continue;
    const marker = await fs.readFile(markerPath, "utf8").catch(() => "");
    if (marker !== runOwnershipMarkerText) continue;

    await fs.rm(ownedPath, { recursive: true, force: true }).catch((error) => {
      console.error("Could not clean an expired local run directory:", error);
    });
  }
}

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.get("/api/auth/chatgpt", async (request, response) => {
  if (!["127.0.0.1", "localhost"].includes(request.hostname)) {
    response.status(403).json({ error: "This local app only accepts requests from its webpage." });
    return;
  }
  try {
    response.json(await getChatGPTConnectionStatus());
  } catch {
    response.status(500).json({ error: "Could not read the local ChatGPT connection." });
  }
});

app.post("/api/auth/chatgpt/start", requireLocalBrowser, async (request, response) => {
  const origin = request.get("origin") ?? "";
  try {
    const redirectUri = `http://${host}:${port}${chatGPTCallbackPath()}`;
    response.json({ authorizationUrl: await startChatGPTSignIn(origin, redirectUri) });
  } catch {
    response.status(500).json({ error: "Could not start ChatGPT sign-in. Please try again." });
  }
});

app.post("/api/auth/chatgpt/disconnect", requireLocalBrowser, async (_request, response) => {
  try {
    response.json({ revoked: await disconnectChatGPT() });
  } catch {
    response.status(500).json({ error: "Could not disconnect ChatGPT locally." });
  }
});

app.get(chatGPTCallbackPath(), async (request, response) => {
  try {
    const returnOrigin = await completeChatGPTSignIn(new URL(request.originalUrl, `http://${host}:${port}`).searchParams);
    response.redirect(303, `${returnOrigin}/?chatgpt=connected`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "ChatGPT sign-in could not be completed.";
    console.warn("ChatGPT sign-in was not completed:", message);
    const query = message.includes("permission") || message.includes("plan usage") ? "permission" : "failed";
    response.redirect(303, `http://${host}:${port}/?chatgpt=${query}`);
  }
});

app.post("/api/runs", requireLocalBrowser, upload.single("resume"), async (request, response) => {
  const file = request.file;
  const jobDescription = typeof request.body.jobDescription === "string" ? request.body.jobDescription.trim() : "";

  if (!file) {
    response.status(400).json({ error: "Choose a DOCX resume to continue." });
    return;
  }
  if (file.size < 4 || file.buffer[0] !== 0x50 || file.buffer[1] !== 0x4b) {
    response.status(400).json({ error: "The uploaded file is not a valid DOCX archive." });
    return;
  }
  if (!jobDescription) {
    response.status(400).json({ error: "Paste the job description to continue." });
    return;
  }
  if (jobDescription.length > jobDescriptionCharacterLimit) {
    response.status(413).json({ error: "The job description must be 30,000 characters or shorter to keep AI analysis bounded." });
    return;
  }

  try {
    const run = await createTailoringRun(file.buffer, file.originalname, jobDescription);
    const stored = scheduleCleanup(run);
    response.status(201).json(stored.response satisfies TailoringRunResponse);
  } catch (error) {
    console.error("Resume tailoring failed:", error);
    const message = error instanceof UserFacingTailoringError
      ? error.message
      : "Resume processing failed. Check that the file is a readable DOCX and try again.";
    response.status(422).json({ error: message });
  }
});

app.get("/api/runs/:runId/resume", (request, response) => {
  const run = lookupRun(request.params.runId);
  if (!run) {
    response.status(404).json({ error: "This tailoring result has expired or does not exist." });
    return;
  }
  response.download(run.resumePath, run.downloadName, (error) => {
    if (error && !response.headersSent) {
      response.status(404).json({ error: "The tailored resume is no longer available." });
    }
  });
});

app.get("/api/runs/:runId/report", (request, response) => {
  const run = lookupRun(request.params.runId);
  if (!run) {
    response.status(404).json({ error: "This tailoring result has expired or does not exist." });
    return;
  }
  response.download(run.reportPath, "tailoring-report.md", (error) => {
    if (error && !response.headersSent) {
      response.status(404).json({ error: "The tailoring report is no longer available." });
    }
  });
});

app.use("/api", (_request, response) => {
  response.status(404).json({ error: "API route not found." });
});

app.use((error: Error, _request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    response.status(413).json({ error: "The resume must be 15 MB or smaller." });
    return;
  }
  if (error instanceof multer.MulterError && error.code === "LIMIT_FIELD_VALUE") {
    response.status(413).json({ error: "The job description upload is too large. Please keep it under 30,000 characters." });
    return;
  }
  if (error.message === "Upload a DOCX resume.") {
    response.status(400).json({ error: error.message });
    return;
  }
  console.error("Local API request failed:", error);
  response.status(500).json({ error: "The request could not be completed. Please try again." });
});

const assetsDirectory = path.resolve(__dirname, "../web/dist");
app.use(express.static(assetsDirectory, { index: "index.html" }));

const server = app.listen(port, host, () => {
  console.log(`TailorResume local web app: http://${host}:${port}`);
  console.log("The full job description is classified in one ChatGPT plan request; up to twelve relevant resume bullets may be included for experience drafting.");
  console.log("Temporary run files expire after one hour.");
  void cleanExpiredRunDirectories();
});

const cleanupSweep = setInterval(() => void cleanExpiredRunDirectories(), 5 * 60 * 1000);
cleanupSweep.unref();

async function cleanRuns(): Promise<void> {
  clearInterval(cleanupSweep);
  const activeRuns = [...runs.values()];
  runs.clear();
  await Promise.all(activeRuns.map(async (run) => {
    clearTimeout(run.cleanupTimer);
    await fs.rm(run.directory, { recursive: true, force: true }).catch(() => undefined);
  }));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => {
      void cleanRuns().finally(() => process.exit(0));
    });
  });
}
