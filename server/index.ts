import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { createHash, randomUUID, timingSafeEqual } from "crypto";
import { inflateRawSync } from "zlib";
import { promises as fs, readFileSync } from "fs";
import * as os from "os";
import * as path from "path";
import type { HostedTailoringRunState, TailoringRunResponse } from "../shared/api";
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
  type TailoringExecutionOptions,
} from "./tailoringService";
import {
  appOrigin,
  beginGoogleSignIn,
  endAppSession,
  finishGoogleSignIn,
  getSupabaseRequestClient,
  getSupabaseAdminClient,
  getSignedInUser,
  isHostedMode,
} from "./supabaseAuth";
import { decryptProviderCredential, encryptProviderCredential } from "./providerCredentials";
import { cleanExpiredHostedTailoring, queueHostedTailoring, recoverAndStartHostedTailoring } from "./hostedTailoring";

const host = process.env.HOST ?? (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");
const port = Number(process.env.PORT ?? process.env.WEB_PORT ?? 4170);
const runRetentionMs = 60 * 60 * 1000;
const uploadLimitBytes = 15 * 1024 * 1024;
const jobDescriptionCharacterLimit = 30_000;
const jobDescriptionLimitBytes = jobDescriptionCharacterLimit * 4;
const platformAiInviteRuns = 3;
const allowedOrigins = new Set([
  "http://127.0.0.1:4170",
  "http://localhost:4170",
  "http://127.0.0.1:5173",
  "http://localhost:5173",
]);

if (process.env.NODE_ENV === "production" && !isHostedMode()) {
  throw new Error("Refusing to start in local mode in production. Set APP_MODE=hosted before exposing this service.");
}

interface StoredRun extends TailoringRunFiles {
  expiresAt: number;
  cleanupTimer: NodeJS.Timeout;
}

const runs = new Map<string, StoredRun>();
let hostedQueuePumpRunning = false;
let hostedQueuePumpRequested = false;
const resumeUploadAttempts = new Map<string, { windowStartedAt: number; count: number; inFlight: boolean }>();
let activeResumeUploads = 0;
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
app.use(express.json({ limit: "2mb", type: "application/json" }));

function requireLocalBrowser(request: Request, response: Response, next: NextFunction): void {
  if (isHostedMode()) {
    response.status(503).json({ error: "Resume tailoring is not enabled in hosted mode until AI connections and persistent run handling are ready." });
    return;
  }
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

async function requireHostedUser(request: Request, response: Response, next: NextFunction): Promise<void> {
  if (!isHostedMode()) {
    response.status(404).json({ error: "Cloud account data is only available in hosted mode." });
    return;
  }
  try {
    const supabase = getSupabaseRequestClient(request, response);
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      response.status(401).json({ error: "Sign in to access your cloud account." });
      return;
    }
    response.locals.accountSupabase = supabase;
    response.locals.accountUserId = data.user.id;
    next();
  } catch {
    response.status(503).json({ error: "Cloud account storage is not available. Please try again later." });
  }
}

function accountSupabase(response: Response): ReturnType<typeof getSupabaseRequestClient> {
  return response.locals.accountSupabase as ReturnType<typeof getSupabaseRequestClient>;
}

function accountUserId(response: Response): string {
  return response.locals.accountUserId as string;
}

type HostedProvider = "anthropic" | "xai" | "openai";

function providerName(value: unknown): HostedProvider | null {
  return value === "anthropic" || value === "xai" || value === "openai" ? value : null;
}

interface ProviderModelOption {
  id: string;
  name: string;
}

class ProviderValidationError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function discoverProviderModels(provider: HostedProvider, apiKey: string): Promise<ProviderModelOption[]> {
  // These are provider-owned catalogue endpoints. They validate the submitted
  // key without sending any resume or job-description text.
  // Anthropic: https://platform.claude.com/docs/en/api/models/list
  // xAI: https://docs.x.ai/developers/rest-api-reference/inference/models
  const url = provider === "anthropic"
    ? "https://api.anthropic.com/v1/models?limit=1000&lifecycle=active"
    : provider === "xai"
      ? "https://api.x.ai/v1/language-models"
      : "https://api.openai.com/v1/models";
  const headers: Record<string, string> = provider === "anthropic"
    ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
    : { Authorization: `Bearer ${apiKey}` };
  let result: globalThis.Response;
  try {
    result = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new ProviderValidationError("The provider could not be reached. Please try again.", 503);
  }
  if (result.status === 401 || result.status === 403) {
    throw new ProviderValidationError("The API key was rejected. Check it with your provider and retry.", 422);
  }
  if (!result.ok) throw new ProviderValidationError("The provider could not verify the API key right now. Please retry.", 503);

  const payload = await result.json().catch(() => null) as Record<string, unknown> | null;
  if (!payload) throw new ProviderValidationError("The provider returned an unreadable model list.", 503);
  const models: ProviderModelOption[] = [];
  if (provider === "anthropic") {
    if (!Array.isArray(payload.data)) throw new ProviderValidationError("The provider returned an unreadable model list.", 503);
    for (const value of payload.data) {
      if (!isRecord(value) || typeof value.id !== "string" || typeof value.display_name !== "string" || value.lifecycle !== "active") continue;
      const capabilities = isRecord(value.capabilities) ? value.capabilities : null;
      const structured = capabilities && isRecord(capabilities.structured_outputs) ? capabilities.structured_outputs : null;
      if (structured?.supported === true) models.push({ id: value.id, name: value.display_name });
    }
  } else if (provider === "xai") {
    if (!Array.isArray(payload.models)) throw new ProviderValidationError("The provider returned an unreadable model list.", 503);
    for (const value of payload.models) {
      if (!isRecord(value) || typeof value.id !== "string") continue;
      const inputModalities = Array.isArray(value.input_modalities) ? value.input_modalities : [];
      const outputModalities = Array.isArray(value.output_modalities) ? value.output_modalities : [];
      if (inputModalities.includes("text") && outputModalities.includes("text")) {
        models.push({ id: value.id, name: value.id });
      }
    }
  } else {
    if (!Array.isArray(payload.data)) throw new ProviderValidationError("The provider returned an unreadable model list.", 503);
    for (const value of payload.data) {
      if (!isRecord(value) || typeof value.id !== "string") continue;
      const id = value.id;
      // The tailoring request needs a text generation model that supports
      // Responses structured output; omit known audio, image, embedding, and
      // moderation-only model families from the selectable list.
      if (!/^(?:gpt-|o[1-9](?:-|$))/.test(id) || /(?:audio|transcrib|tts|image|embed|moderation|realtime|search|sora)/i.test(id)) continue;
      models.push({ id, name: id });
    }
  }
  if (models.length === 0) {
    throw new ProviderValidationError("This key has no available text model that TailorResume can use yet.", 422);
  }
  return models.slice(0, 100);
}

function requireHostedOrigin(request: Request, response: Response, next: NextFunction): void {
  try {
    if (!request.get("origin") || request.get("origin") !== appOrigin()) {
      response.status(403).json({ error: "This request did not come from TailorResume." });
      return;
    }
    next();
  } catch {
    response.status(503).json({ error: "Cloud account storage is not available. Please try again later." });
  }
}

function requireResumeUploadCapacity(_request: Request, response: Response, next: NextFunction): void {
  const userId = accountUserId(response);
  const now = Date.now();
  let account = resumeUploadAttempts.get(userId);
  if (!account || (!account.inFlight && now - account.windowStartedAt >= 60 * 60 * 1000)) {
    account = { windowStartedAt: now, count: 0, inFlight: false };
    if (resumeUploadAttempts.size > 5_000) {
      for (const [knownUserId, knownAccount] of resumeUploadAttempts) {
        if (!knownAccount.inFlight && now - knownAccount.windowStartedAt >= 60 * 60 * 1000) resumeUploadAttempts.delete(knownUserId);
      }
    }
    if (resumeUploadAttempts.size > 10_000) {
      for (const [knownUserId, knownAccount] of resumeUploadAttempts) {
        if (!knownAccount.inFlight) resumeUploadAttempts.delete(knownUserId);
        if (resumeUploadAttempts.size <= 8_000) break;
      }
    }
    resumeUploadAttempts.set(userId, account);
  }
  if (account.inFlight || activeResumeUploads >= 3) {
    response.status(429).json({ error: "A resume upload is already in progress. Please wait and retry." });
    return;
  }
  if (account.count >= 5) {
    response.status(429).json({ error: "Resume upload limit reached. Please try again in an hour." });
    return;
  }

  account.count += 1;
  account.inFlight = true;
  activeResumeUploads += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    account!.inFlight = false;
    activeResumeUploads = Math.max(0, activeResumeUploads - 1);
  };
  response.once("finish", release);
  response.once("close", release);
  next();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function platformAiConfiguration(): { apiKey: string; model: string } | null {
  const apiKey = process.env.TAILORRESUME_PLATFORM_AI_API_KEY?.trim();
  const model = process.env.TAILORRESUME_PLATFORM_AI_MODEL?.trim();
  return apiKey && model ? { apiKey, model } : null;
}

function matchesPlatformAiInvite(code: string): boolean {
  const expected = process.env.TAILORRESUME_INITIAL_AI_ACCESS_CODE?.trim();
  if (!expected || !code) return false;
  const expectedDigest = createHash("sha256").update(expected).digest();
  const suppliedDigest = createHash("sha256").update(code).digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
}

function hostedRunState(row: Record<string, unknown>): HostedTailoringRunState {
  return {
    runId: String(row.id),
    status: row.status as HostedTailoringRunState["status"],
    provider: typeof row.provider === "string" ? row.provider : null,
    model: typeof row.model === "string" ? row.model : null,
    createdAt: typeof row.created_at === "string" ? row.created_at : new Date().toISOString(),
    result: isRecord(row.result_data) ? row.result_data as unknown as TailoringRunResponse : null,
    error: typeof row.error_code === "string" ? row.error_code : null,
  };
}

function validRunId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isText(value: unknown, maximumLength: number, required = true): value is string {
  return typeof value === "string"
    && (required ? value.trim().length > 0 : true)
    && value.length <= maximumLength;
}

function isExperienceProfile(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !Array.isArray(value.facts) || !Array.isArray(value.verifiedSkills)) return false;
  if (value.facts.length > 500 || value.verifiedSkills.length > 1000) return false;
  if (value.sourceResume !== undefined && !isText(value.sourceResume, 1000, false)) return false;
  if (value.sourceSha256 !== undefined && (typeof value.sourceSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(value.sourceSha256))) return false;

  const validFacts = value.facts.every((fact) => {
    if (!isRecord(fact)) return false;
    const hasTarget = fact.targetParagraphId !== undefined;
    const hasAfter = fact.afterParagraphId !== undefined;
    return isText(fact.id, 128)
      && typeof fact.verified === "boolean"
      && Array.isArray(fact.requirements)
      && fact.requirements.length <= 100
      && fact.requirements.every((requirement) => isText(requirement, 200))
      && isText(fact.text, 8000)
      && (fact.supplementText === undefined || isText(fact.supplementText, 8000))
      && (!hasTarget || isText(fact.targetParagraphId, 128))
      && (!hasAfter || isText(fact.afterParagraphId, 128))
      && !(hasTarget && hasAfter)
      && (fact.userConfirmed === undefined || typeof fact.userConfirmed === "boolean")
      && (fact.source === undefined || isText(fact.source, 500, false));
  });
  const validSkills = value.verifiedSkills.every((skill) => {
    if (!isRecord(skill)) return false;
    return isText(skill.canonical, 200)
      && (skill.aliases === undefined || (Array.isArray(skill.aliases) && skill.aliases.length <= 100 && skill.aliases.every((alias) => isText(alias, 200))))
      && typeof skill.verified === "boolean"
      && (skill.userConfirmed === undefined || typeof skill.userConfirmed === "boolean")
      && (skill.category === undefined || isText(skill.category, 200))
      && (skill.source === undefined || isText(skill.source, 500, false));
  });
  if (!validFacts || !validSkills) return false;
  const factIds = value.facts.map((fact) => (fact as Record<string, unknown>).id);
  return new Set(factIds).size === factIds.length;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function extractDocxDocumentXml(buffer: Buffer): string | null {
  const requiredMembers = new Set(["[Content_Types].xml", "_rels/.rels", "word/document.xml"]);
  const maxExpandedBytes = 100 * 1024 * 1024;
  const maxXmlMemberBytes = 20 * 1024 * 1024;
  if (buffer.length < 22) return null;

  try {
    let documentXml: string | null = null;
    let endRecord = -1;
    for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset -= 1) {
      if (buffer.readUInt32LE(offset) === 0x06054b50) {
        const commentLength = buffer.readUInt16LE(offset + 20);
        if (offset + 22 + commentLength === buffer.length) {
          endRecord = offset;
          break;
        }
      }
    }
    if (endRecord < 0) return null;
    const diskNumber = buffer.readUInt16LE(endRecord + 4);
    const directoryDisk = buffer.readUInt16LE(endRecord + 6);
    const entriesOnDisk = buffer.readUInt16LE(endRecord + 8);
    const entryCount = buffer.readUInt16LE(endRecord + 10);
    const directorySize = buffer.readUInt32LE(endRecord + 12);
    const directoryOffset = buffer.readUInt32LE(endRecord + 16);
    if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount || entryCount === 0xffff) return null;
    if (directorySize === 0xffffffff || directoryOffset === 0xffffffff) return null;
    if (entryCount > 10_000 || directoryOffset + directorySize > endRecord) return null;

    const members = new Map<string, { method: number; flags: number; crc: number; compressedSize: number; expandedSize: number; localOffset: number }>();
    let expandedTotal = 0;
    let cursor = directoryOffset;
    for (let index = 0; index < entryCount; index += 1) {
      if (cursor + 46 > directoryOffset + directorySize || buffer.readUInt32LE(cursor) !== 0x02014b50) return null;
      const flags = buffer.readUInt16LE(cursor + 8);
      const method = buffer.readUInt16LE(cursor + 10);
      const expectedCrc = buffer.readUInt32LE(cursor + 16);
      const compressedSize = buffer.readUInt32LE(cursor + 20);
      const expandedSize = buffer.readUInt32LE(cursor + 24);
      const nameLength = buffer.readUInt16LE(cursor + 28);
      const extraLength = buffer.readUInt16LE(cursor + 30);
      const commentLength = buffer.readUInt16LE(cursor + 32);
      const diskStart = buffer.readUInt16LE(cursor + 34);
      const localOffset = buffer.readUInt32LE(cursor + 42);
      const entryEnd = cursor + 46 + nameLength + extraLength + commentLength;
      if (entryEnd > directoryOffset + directorySize || diskStart !== 0) return null;
      if ((flags & 1) !== 0 || (method !== 0 && method !== 8)) return null;
      if (compressedSize === 0xffffffff || expandedSize === 0xffffffff || localOffset === 0xffffffff) return null;
      expandedTotal += expandedSize;
      if (expandedTotal > maxExpandedBytes) return null;
      const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);
      if (requiredMembers.has(name)) {
        if (members.has(name) || expandedSize > maxXmlMemberBytes) return null;
        members.set(name, { method, flags, crc: expectedCrc, compressedSize, expandedSize, localOffset });
      }
      cursor = entryEnd;
    }
    if (cursor !== directoryOffset + directorySize || members.size !== requiredMembers.size) return null;

    for (const [name, entry] of members) {
      if (entry.localOffset + 30 > buffer.length || buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) return null;
      const localNameLength = buffer.readUInt16LE(entry.localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(entry.localOffset + 28);
      if (entry.localOffset + 30 + localNameLength + localExtraLength > buffer.length) return null;
      const localName = buffer.toString("utf8", entry.localOffset + 30, entry.localOffset + 30 + localNameLength);
      const localMethod = buffer.readUInt16LE(entry.localOffset + 8);
      const localFlags = buffer.readUInt16LE(entry.localOffset + 6);
      if (localName !== name || localMethod !== entry.method || localFlags !== entry.flags) return null;
      const dataStart = entry.localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + entry.compressedSize;
      if (dataEnd > directoryOffset || dataEnd > buffer.length) return null;
      const compressed = buffer.subarray(dataStart, dataEnd);
      const contents = entry.method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: maxXmlMemberBytes });
      if (contents.length !== entry.expandedSize || crc32(contents) !== entry.crc) return null;
      const xml = contents.toString("utf8");
      if (name === "[Content_Types].xml" && !/<(?:\w+:)?Types\b/.test(xml)) return null;
      if (name === "_rels/.rels" && !/<(?:\w+:)?Relationships\b/.test(xml)) return null;
      if (name === "word/document.xml") {
        if (!/<(?:\w+:)?document\b/.test(xml)) return null;
        documentXml = xml;
      }
    }
    return documentXml;
  } catch {
    return null;
  }
}

function decodeXmlText(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_match, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[entity.toLowerCase()] ?? "";
  });
}

function resumeTextFromDocumentXml(documentXml: string): string {
  return [...documentXml.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)]
    .map((match) => decodeXmlText(match[1]))
    .join(" ");
}

function normalizeSkill(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9+#.]+/g, " ").trim().replace(/\s+/g, " ");
}

function extractVerifiedSkills(resumeText: string): Array<Record<string, unknown>> {
  const dictionary = JSON.parse(readFileSync(path.resolve(process.cwd(), "config/skill-dictionary.json"), "utf8")) as unknown;
  if (!Array.isArray(dictionary)) throw new Error("The technical skill dictionary is unavailable.");
  const normalizedResume = normalizeSkill(resumeText);
  const found = new Map<string, Record<string, unknown>>();
  for (const item of dictionary) {
    if (!isRecord(item) || !isText(item.canonical, 200)) continue;
    const aliases = [item.canonical, ...(Array.isArray(item.aliases) ? item.aliases.filter((alias): alias is string => typeof alias === "string") : [])];
    const matched = aliases.some((alias) => {
      const normalizedAlias = normalizeSkill(alias);
      return normalizedAlias.length > 1 && ` ${normalizedResume} `.includes(` ${normalizedAlias} `);
    });
    if (!matched) continue;
    const key = normalizeSkill(item.canonical);
    found.set(key, {
      canonical: item.canonical,
      aliases,
      verified: true,
      userConfirmed: true,
      ...(typeof item.category === "string" ? { category: item.category } : {}),
      source: "Detected in uploaded resume",
    });
  }
  return [...found.values()];
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
  response.json({ status: "ok", mode: isHostedMode() ? "hosted" : "local" });
});

app.get("/api/auth/session", async (request, response) => {
  if (!isHostedMode()) {
    response.json({ mode: "local", authenticated: true, user: null });
    return;
  }
  try {
    const user = await getSignedInUser(request, response);
    if (!user) {
      response.status(401).json({ mode: "hosted", authenticated: false, user: null });
      return;
    }
    response.json({ mode: "hosted", authenticated: true, user });
  } catch {
    response.status(503).json({ mode: "hosted", authenticated: false, error: "Hosted sign-in is not configured. Please try again later." });
  }
});

app.get("/auth/google/start", async (request, response) => {
  if (!isHostedMode()) {
    response.status(404).send("Not found");
    return;
  }
  try {
    const authorizationUrl = await beginGoogleSignIn(request, response);
    response.redirect(303, authorizationUrl);
  } catch (error) {
    console.error("Could not start hosted Google sign-in:", error instanceof Error ? error.message : "unknown error");
    response.status(503).send("Google sign-in is not configured yet. Please try again later.");
  }
});

app.get("/auth/google/callback", async (request, response) => {
  if (!isHostedMode()) {
    response.status(404).send("Not found");
    return;
  }
  const code = typeof request.query.code === "string" ? request.query.code : "";
  if (!code || code.length > 4096) {
    response.redirect(303, "/?auth=failed");
    return;
  }
  try {
    await finishGoogleSignIn(request, response, code);
    response.redirect(303, "/?auth=signed-in");
  } catch (error) {
    console.warn("Hosted Google sign-in was not completed:", error instanceof Error ? error.message : "unknown error");
    response.redirect(303, "/?auth=failed");
  }
});

app.post("/api/auth/logout", async (request, response) => {
  if (!isHostedMode()) {
    response.status(404).json({ error: "Hosted sign-out is not available in local mode." });
    return;
  }
  try {
    const origin = request.get("origin");
    if (!origin || origin !== appOrigin()) {
      response.status(403).json({ error: "This request did not come from TailorResume." });
      return;
    }
    await endAppSession(request, response);
    response.status(204).end();
  } catch {
    response.status(503).json({ error: "Could not sign out. Please retry." });
  }
});

app.get("/api/account", requireHostedUser, async (_request, response) => {
  const supabase = accountSupabase(response);
  const userId = accountUserId(response);
  try {
    const [profileResult, resumesResult] = await Promise.all([
      supabase.from("user_profiles").select("display_name").eq("user_id", userId).maybeSingle(),
      supabase.from("resumes")
        .select("id, display_name, original_file_name, file_size_bytes, sha256, is_default, created_at")
        .eq("user_id", userId)
        .is("deleted_at", null)
        .order("created_at", { ascending: false }),
    ]);
    if (profileResult.error || resumesResult.error) {
      console.error("Could not load hosted account records.");
      response.status(503).json({ error: "Your cloud account data could not be loaded. Please try again." });
      return;
    }
    response.json({
      displayName: profileResult.data?.display_name ?? null,
      resumes: resumesResult.data ?? [],
    });
  } catch {
    response.status(503).json({ error: "Your cloud account data could not be loaded. Please try again." });
  }
});

app.get("/api/account/platform-ai-access", requireHostedUser, async (_request, response) => {
  const configuration = platformAiConfiguration();
  if (!configuration) {
    response.json({ enabled: false, redeemed: false, runsGranted: 0, runsRemaining: 0 });
    return;
  }
  try {
    const result = await getSupabaseAdminClient().from("platform_ai_access")
      .select("runs_granted, runs_used")
      .eq("user_id", accountUserId(response))
      .maybeSingle();
    if (result.error) {
      console.error("Could not load platform AI access.");
      response.status(503).json({ error: "Platform AI access could not be loaded. Apply the latest Supabase migration, then retry." });
      return;
    }
    const runsGranted = Number(result.data?.runs_granted ?? 0);
    const runsUsed = Number(result.data?.runs_used ?? 0);
    response.json({
      enabled: true,
      redeemed: Boolean(result.data),
      runsGranted,
      runsRemaining: Math.max(0, runsGranted - runsUsed),
      model: configuration.model,
    });
  } catch {
    response.status(503).json({ error: "Platform AI access could not be loaded. Please retry." });
  }
});

app.post("/api/account/platform-ai-access/redeem", requireHostedUser, requireHostedOrigin, async (request, response) => {
  if (!isRecord(request.body) || Object.keys(request.body).sort().join(",") !== "code" ||
      typeof request.body.code !== "string" || request.body.code.length > 200) {
    response.status(400).json({ error: "Enter a valid AI access code." });
    return;
  }
  if (!platformAiConfiguration()) {
    response.status(503).json({ error: "TailorResume AI access is not configured yet." });
    return;
  }
  if (!matchesPlatformAiInvite(request.body.code)) {
    response.status(403).json({ error: "That AI access code is not valid." });
    return;
  }
  try {
    const result = await getSupabaseAdminClient().rpc("redeem_platform_ai_invite", {
      p_user_id: accountUserId(response),
      p_runs_granted: platformAiInviteRuns,
    });
    if (result.error || !isRecord(result.data)) {
      console.error("Could not redeem platform AI access.");
      response.status(503).json({ error: "AI access could not be activated. Apply the latest Supabase migration, then retry." });
      return;
    }
    response.json({
      access: {
        enabled: true,
        redeemed: true,
        newlyRedeemed: result.data.newlyRedeemed === true,
        runsGranted: Number(result.data.runsGranted ?? 0),
        runsRemaining: Number(result.data.runsRemaining ?? 0),
        model: platformAiConfiguration()?.model,
      },
    });
  } catch {
    response.status(503).json({ error: "AI access could not be activated. Please retry." });
  }
});

app.get("/api/account/runs/latest", requireHostedUser, async (_request, response) => {
  try {
    const result = await accountSupabase(response).from("tailoring_runs")
      .select("id, status, provider, model, created_at, result_data, error_code")
      .eq("user_id", accountUserId(response))
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (result.error) {
      response.status(503).json({ error: "Your latest tailoring run could not be loaded. Please retry." });
      return;
    }
    if (!result.data) {
      response.status(404).json({ error: "No saved tailoring run was found." });
      return;
    }
    response.json({ run: hostedRunState(result.data) });
  } catch {
    response.status(503).json({ error: "Your latest tailoring run could not be loaded. Please retry." });
  }
});

app.post("/api/account/runs", requireHostedUser, requireHostedOrigin, async (request, response) => {
  const body = request.body;
  const jobDescription = typeof body?.jobDescription === "string" ? body.jobDescription.trim() : "";
  if (!isRecord(body) || Object.keys(body).sort().join(",") !== "aiConsent,aiSource,jobDescription,provider" ||
      (body.provider !== "anthropic" && body.provider !== "openai") ||
      (body.aiSource !== "user" && body.aiSource !== "platform") || body.aiConsent !== true ||
      (body.aiSource === "platform" && body.provider !== "openai")) {
    response.status(400).json({ error: "Choose an available AI provider and confirm the AI data-sharing notice before starting a run." });
    return;
  }
  if (!jobDescription || jobDescription.length > jobDescriptionCharacterLimit) {
    response.status(jobDescription.length > jobDescriptionCharacterLimit ? 413 : 400).json({ error: "Paste a job description from 1 to 30,000 characters." });
    return;
  }

  const userId = accountUserId(response);
  const accountClient = accountSupabase(response);
  try {
    const admin = getSupabaseAdminClient();
    const [resumeResult, profileResult] = await Promise.all([
      accountClient.from("resumes")
        .select("id, original_file_name")
        .eq("user_id", userId)
        .eq("is_default", true)
        .is("deleted_at", null)
        .maybeSingle(),
      accountClient.from("experience_profiles").select("user_id").eq("user_id", userId).maybeSingle(),
    ]);
    if (resumeResult.error || !resumeResult.data) {
      response.status(409).json({ error: "Upload a base resume before starting a tailoring run." });
      return;
    }
    if (profileResult.error || !profileResult.data) {
      response.status(409).json({ error: "Upload or replace your base resume to create its profile before starting a tailoring run." });
      return;
    }
    let selectedModel: string;
    if (body.aiSource === "platform") {
      const configuration = platformAiConfiguration();
      if (!configuration) {
        response.status(503).json({ error: "TailorResume AI access is not configured yet." });
        return;
      }
      selectedModel = configuration.model;
    } else {
      const providerResult = await admin.from("provider_connections")
        .select("selected_model, credential_ciphertext")
        .eq("user_id", userId)
        .eq("provider", body.provider)
        .maybeSingle();
      if (providerResult.error || !providerResult.data?.credential_ciphertext || typeof providerResult.data.selected_model !== "string") {
        response.status(409).json({ error: `Connect a ${body.provider === "openai" ? "OpenAI API" : "Claude"} key and select a model before starting a tailoring run.` });
        return;
      }
      selectedModel = providerResult.data.selected_model;
    }

    const recentRuns = await admin.from("tailoring_runs")
      .select("id")
      .eq("user_id", userId)
      .gte("created_at", new Date(Date.now() - 60 * 60 * 1000).toISOString())
      .limit(5);
    if (recentRuns.error) {
      response.status(503).json({ error: "The tailoring run limit could not be checked. Please retry." });
      return;
    }
    if ((recentRuns.data?.length ?? 0) >= 5) {
      response.status(429).json({ error: "You have reached the limit of five tailoring runs per hour. Please try again later." });
      return;
    }

    const runId = randomUUID();
    const runParameters = {
      p_user_id: userId,
      p_run_id: runId,
      p_source_resume_id: resumeResult.data.id,
      p_job_description: jobDescription,
    };
    const saved = body.aiSource === "platform"
      ? await admin.rpc("create_platform_ai_tailoring_run", { ...runParameters, p_model: selectedModel })
      : await admin.rpc("create_hosted_tailoring_run", { ...runParameters, p_provider: body.provider, p_model: selectedModel });
    if (saved.error || !isRecord(saved.data)) {
      if (saved.error?.code === "23505") {
        response.status(409).json({ error: "You already have a tailoring run in progress. Wait for it to finish before starting another." });
        return;
      }
      if (saved.error?.code === "P0002") {
        response.status(409).json({ error: "Your default resume changed. Reload your account and retry the tailoring run." });
        return;
      }
      if (saved.error?.code === "P0001") {
        response.status(403).json({ error: "Your TailorResume AI run allowance is used. Enter an eligible access code or connect your own AI provider key." });
        return;
      }
      console.error("Could not save a hosted tailoring request.");
      response.status(503).json({ error: "The tailoring run could not be queued. Apply the latest Supabase migration, then retry." });
      return;
    }
    response.status(202).json({ run: hostedRunState(saved.data) });
    queueHostedTailoring();
  } catch {
    response.status(503).json({ error: "The tailoring run could not be queued. Please retry." });
  }
});

app.get("/api/account/runs/:runId", requireHostedUser, async (request, response) => {
  const runId = request.params.runId;
  if (!validRunId(runId)) {
    response.status(404).json({ error: "That tailoring run was not found." });
    return;
  }
  try {
    const result = await accountSupabase(response).from("tailoring_runs")
      .select("id, status, provider, model, created_at, result_data, error_code")
      .eq("id", runId)
      .eq("user_id", accountUserId(response))
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    if (result.error || !result.data) {
      response.status(404).json({ error: "That tailoring run was not found." });
      return;
    }
    response.json({ run: hostedRunState(result.data) });
  } catch {
    response.status(503).json({ error: "The tailoring run could not be loaded. Please retry." });
  }
});

app.get("/api/account/runs/:runId/resume", requireHostedUser, async (request, response) => {
  const runId = request.params.runId;
  if (!validRunId(runId)) {
    response.status(404).json({ error: "That tailored resume was not found." });
    return;
  }
  try {
    const row = await accountSupabase(response).from("tailoring_runs")
      .select("output_object_key, status")
      .eq("id", runId)
      .eq("user_id", accountUserId(response))
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    if (row.error || row.data?.status !== "succeeded" || !row.data.output_object_key) {
      response.status(404).json({ error: "That tailored resume was not found." });
      return;
    }
    const signed = await accountSupabase(response).storage.from("resume-files").createSignedUrl(row.data.output_object_key, 60, { download: "TailorResume-tailored.docx" });
    if (signed.error || !signed.data?.signedUrl) {
      response.status(503).json({ error: "The tailored resume download is temporarily unavailable." });
      return;
    }
    response.redirect(303, signed.data.signedUrl);
  } catch {
    response.status(503).json({ error: "The tailored resume download is temporarily unavailable." });
  }
});

app.delete("/api/account/runs/:runId", requireHostedUser, requireHostedOrigin, async (request, response) => {
  const runId = request.params.runId;
  if (!validRunId(runId)) {
    response.status(404).json({ error: "That tailoring run was not found." });
    return;
  }
  const userId = accountUserId(response);
  try {
    const row = await accountSupabase(response).from("tailoring_runs")
      .select("id, status, output_object_key")
      .eq("id", runId)
      .eq("user_id", userId)
      .maybeSingle();
    if (row.error || !row.data) {
      response.status(404).json({ error: "That tailoring run was not found." });
      return;
    }
    if (row.data.status === "queued" || row.data.status === "running") {
      response.status(409).json({ error: "Wait for the tailoring run to finish before deleting it." });
      return;
    }
    if (row.data.output_object_key) {
      const removed = await accountSupabase(response).storage.from("resume-files").remove([row.data.output_object_key]);
      if (removed.error) {
        response.status(503).json({ error: "The tailored resume file could not be deleted. Please retry." });
        return;
      }
    }
    const deleted = await getSupabaseAdminClient().from("tailoring_runs").delete().eq("id", runId).eq("user_id", userId);
    if (deleted.error) {
      response.status(503).json({ error: "The tailoring run record could not be deleted. Please retry." });
      return;
    }
    response.status(204).end();
  } catch {
    response.status(503).json({ error: "The tailoring run could not be deleted. Please retry." });
  }
});

app.get("/api/account/providers", requireHostedUser, async (_request, response) => {
  try {
    const result = await accountSupabase(response).rpc("get_my_provider_connections");
    if (result.error) {
      console.error("Could not load hosted AI provider connections.");
      response.status(503).json({ error: "AI provider connections could not be loaded. Apply the latest Supabase migration, then retry." });
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    response.json({ connections: result.data ?? [] });
  } catch {
    response.status(503).json({ error: "AI provider connections could not be loaded. Please try again." });
  }
});

app.put("/api/account/providers/:provider", requireHostedUser, requireHostedOrigin, async (request, response) => {
  const provider = providerName(request.params.provider);
  const credential = request.body?.apiKey;
  if (!provider || !isRecord(request.body) || Object.keys(request.body).length !== 1 || !isText(credential, 500) || credential.length < 20) {
    response.status(400).json({ error: "Enter a valid Claude, Grok, or OpenAI API key." });
    return;
  }
  if (credential.trim() !== credential || /\s/.test(credential)) {
    response.status(400).json({ error: "The API key must not contain surrounding or embedded whitespace." });
    return;
  }
  try {
    const encrypted = encryptProviderCredential(accountUserId(response), provider, credential);
    const models = await discoverProviderModels(provider, credential);
    const selectedModel = models[0].id;
    const result = await accountSupabase(response).rpc("save_my_provider_connection", {
      p_provider: provider,
      p_provider_account_label: null,
      p_credential_ciphertext: encrypted.ciphertext,
      p_credential_iv: encrypted.iv,
      p_credential_auth_tag: encrypted.authTag,
      p_key_version: encrypted.keyVersion,
      p_selected_model: selectedModel,
    });
    if (result.error) {
      console.error("Could not save hosted AI provider connection.");
      response.status(503).json({ error: "The provider key could not be saved. Apply the latest Supabase migration and confirm server encryption is configured." });
      return;
    }
    response.json({ models, selectedModel });
  } catch (error) {
    if (error instanceof ProviderValidationError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    if (error instanceof Error && error.message === "AI provider connections are not configured.") {
      response.status(503).json({ error: "AI provider connections are not configured on this service yet." });
      return;
    }
    response.status(503).json({ error: "The provider key could not be saved. Please try again." });
  }
});

app.get("/api/account/providers/:provider/models", requireHostedUser, async (request, response) => {
  const provider = providerName(request.params.provider);
  if (!provider) {
    response.status(404).json({ error: "That AI provider connection was not found." });
    return;
  }
  try {
    const userId = accountUserId(response);
    const result = await getSupabaseAdminClient().from("provider_connections")
      .select("credential_ciphertext, credential_iv, credential_auth_tag, key_version, selected_model")
      .eq("user_id", userId)
      .eq("provider", provider)
      .maybeSingle();
    if (result.error || !result.data) {
      response.status(404).json({ error: "Save a provider key before choosing a model." });
      return;
    }
    const apiKey = decryptProviderCredential(userId, provider, {
      ciphertext: result.data.credential_ciphertext,
      iv: result.data.credential_iv,
      authTag: result.data.credential_auth_tag,
      keyVersion: result.data.key_version,
    });
    const models = await discoverProviderModels(provider, apiKey);
    response.json({ models, selectedModel: result.data.selected_model });
  } catch (error) {
    if (error instanceof ProviderValidationError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    console.error("Could not load provider model options for the signed-in account.");
    response.status(503).json({ error: "Available models could not be loaded. Please retry." });
  }
});

app.put("/api/account/providers/:provider/model", requireHostedUser, requireHostedOrigin, async (request, response) => {
  const provider = providerName(request.params.provider);
  const modelId = request.body?.modelId;
  if (!provider) {
    response.status(404).json({ error: "That AI provider connection was not found." });
    return;
  }
  if (!isRecord(request.body) || Object.keys(request.body).length !== 1 || !isText(modelId, 200) || modelId.length < 1 || modelId.trim() !== modelId) {
    response.status(400).json({ error: "Choose a valid model from the provider catalogue." });
    return;
  }
  try {
    const userId = accountUserId(response);
    const result = await getSupabaseAdminClient().from("provider_connections")
      .select("credential_ciphertext, credential_iv, credential_auth_tag, key_version")
      .eq("user_id", userId)
      .eq("provider", provider)
      .maybeSingle();
    if (result.error || !result.data) {
      response.status(404).json({ error: "Save a provider key before choosing a model." });
      return;
    }
    const apiKey = decryptProviderCredential(userId, provider, {
      ciphertext: result.data.credential_ciphertext,
      iv: result.data.credential_iv,
      authTag: result.data.credential_auth_tag,
      keyVersion: result.data.key_version,
    });
    const models = await discoverProviderModels(provider, apiKey);
    if (!models.some((model) => model.id === modelId)) {
      response.status(422).json({ error: "That model is not currently available to this provider key." });
      return;
    }
    const saved = await accountSupabase(response).rpc("set_my_provider_model", {
      p_provider: provider,
      p_selected_model: modelId,
    });
    if (saved.error) {
      console.error("Could not save the signed-in account's provider model.");
      response.status(503).json({ error: "The model selection could not be saved. Apply the latest Supabase migration, then retry." });
      return;
    }
    response.json({ selectedModel: modelId });
  } catch (error) {
    if (error instanceof ProviderValidationError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    console.error("Could not save provider model selection for the signed-in account.");
    response.status(503).json({ error: "The model selection could not be saved. Please retry." });
  }
});

app.delete("/api/account/providers/:provider", requireHostedUser, requireHostedOrigin, async (request, response) => {
  const provider = providerName(request.params.provider);
  if (!provider) {
    response.status(404).json({ error: "That AI provider connection was not found." });
    return;
  }
  try {
    const result = await accountSupabase(response).rpc("delete_my_provider_connection", { p_provider: provider });
    if (result.error) {
      console.error("Could not delete hosted AI provider connection.");
      response.status(503).json({ error: "The provider key could not be removed. Apply the latest Supabase migration, then retry." });
      return;
    }
    response.status(204).end();
  } catch {
    response.status(503).json({ error: "The provider key could not be removed. Please retry." });
  }
});

app.post("/api/account/resume", requireHostedUser, requireHostedOrigin, requireResumeUploadCapacity, upload.single("resume"), async (request, response) => {
  const file = request.file;
  if (!file) {
    response.status(400).json({ error: "Choose a DOCX resume to upload." });
    return;
  }
  const documentXml = file.size >= 4 && file.buffer[0] === 0x50 && file.buffer[1] === 0x4b
    ? extractDocxDocumentXml(file.buffer)
    : null;
  if (!documentXml) {
    response.status(400).json({ error: "The uploaded file is not a valid DOCX resume." });
    return;
  }

  const supabase = accountSupabase(response);
  const userId = accountUserId(response);
  const originalFileName = path.basename(file.originalname.replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f]/g, "_").slice(0, 255);
  if (!originalFileName || !originalFileName.toLowerCase().endsWith(".docx")) {
    response.status(400).json({ error: "Choose a DOCX resume to upload." });
    return;
  }
  const objectKey = `${userId}/${randomUUID()}.docx`;
  const fileArrayBuffer = file.buffer.buffer.slice(file.buffer.byteOffset, file.buffer.byteOffset + file.buffer.byteLength) as ArrayBuffer;
  const sha256 = createHash("sha256").update(file.buffer).digest("hex");
  let detectedSkills: Array<Record<string, unknown>>;
  let profileData: Record<string, unknown>;
  try {
    const existingProfile = await supabase.from("experience_profiles").select("profile_data").eq("user_id", userId).maybeSingle();
    if (existingProfile.error || !existingProfile.data || !isExperienceProfile(existingProfile.data.profile_data)) {
      console.error("Could not load the hosted profile before replacing the resume.");
      response.status(503).json({ error: "Your resume profile could not be prepared. Please retry." });
      return;
    }
    detectedSkills = extractVerifiedSkills(resumeTextFromDocumentXml(documentXml));
    const mergedSkills = new Map<string, Record<string, unknown>>();
    for (const skill of existingProfile.data.profile_data.verifiedSkills as Array<Record<string, unknown>>) {
      mergedSkills.set(normalizeSkill(String(skill.canonical)), skill);
    }
    for (const skill of detectedSkills) {
      const key = normalizeSkill(String(skill.canonical));
      const previous = mergedSkills.get(key);
      const aliases = new Set<string>([
        ...(Array.isArray(previous?.aliases) ? previous.aliases.filter((alias): alias is string => typeof alias === "string") : []),
        ...(Array.isArray(skill.aliases) ? skill.aliases.filter((alias): alias is string => typeof alias === "string") : []),
      ]);
      mergedSkills.set(key, { ...previous, ...skill, aliases: [...aliases] });
    }
    profileData = {
      sourceResume: originalFileName,
      sourceSha256: sha256,
      facts: [],
      verifiedSkills: [...mergedSkills.values()],
    };
  } catch {
    console.error("Could not extract the hosted resume profile.");
    response.status(503).json({ error: "The resume could not be analyzed for its experience profile. Please retry." });
    return;
  }
  const storage = supabase.storage.from("resume-files");
  let objectUploaded = false;
  let replacementRpcStarted = false;

  const sendSavedResume = (row: Record<string, unknown>, cleanupWarning: boolean) => {
    response.status(201).json({
      resume: {
        id: row.id,
        display_name: row.display_name,
        original_file_name: row.original_file_name,
        file_size_bytes: row.file_size_bytes,
        sha256: row.sha256,
        is_default: row.is_default,
        created_at: row.created_at,
      },
      detectedSkillCount: detectedSkills.length,
      cleanupWarning,
    });
  };

  try {
    const uploadResult = await storage.upload(objectKey, fileArrayBuffer, {
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      upsert: false,
    });
    if (uploadResult.error) {
      console.error("Could not store a hosted resume object.");
      response.status(503).json({ error: "Your resume could not be saved to secure storage. Please try again." });
      return;
    }
    objectUploaded = true;

    const displayName = path.parse(originalFileName).name.slice(0, 255) || "Resume";
    replacementRpcStarted = true;
    const replaceResult = await supabase.rpc("replace_default_resume", {
      p_display_name: displayName,
      p_original_file_name: originalFileName,
      p_object_key: objectKey,
      p_file_size_bytes: file.size,
      p_sha256: sha256,
      p_experience_profile: profileData,
    });
    const replacePayload = isRecord(replaceResult.data) ? replaceResult.data : null;
    let newResume = replacePayload && isRecord(replacePayload.resume) ? replacePayload.resume : null;
    let cleanupWarning = false;
    let replacedRows = replacePayload && Array.isArray(replacePayload.replaced)
      ? replacePayload.replaced.filter(isRecord)
      : [];

    if (replaceResult.error || !newResume || typeof newResume.id !== "string") {
      if (replaceResult.error?.code === "55000") {
        await storage.remove([objectKey]).catch(() => undefined);
        response.status(409).json({ error: "Wait for the active tailoring run to finish before replacing this resume." });
        return;
      }
      // A connection can fail after Postgres commits. Check by the unique object
      // key before cleaning up, so an uncertain response cannot orphan a saved
      // row from its uploaded file.
      const reconciliation = await supabase.from("resumes")
        .select("id, display_name, original_file_name, file_size_bytes, sha256, is_default, created_at")
        .eq("user_id", userId)
        .eq("object_key", objectKey)
        .maybeSingle();
      if (reconciliation.error) {
        response.status(503).json({ error: "Resume save status is still being confirmed. Reload your account before retrying." });
        return;
      }
      if (reconciliation.data) {
        sendSavedResume(reconciliation.data, true);
        return;
      }
      // A failed RPC response can arrive while its transaction is still
      // finishing. Keep the object when the commit outcome is uncertain; an
      // orphan cleanup task can remove it after checking the database later.
      console.error("Could not create hosted resume metadata.");
      response.status(503).json({ error: "Your resume could not be saved. Confirm the latest Supabase migrations are applied, then retry." });
      return;
    }

    if (replacedRows.length > 0) {
      const oldObjectKeys = replacedRows.map((resumeRow) => resumeRow.object_key).filter((key): key is string => typeof key === "string");
      const removeOldObjects = oldObjectKeys.length > 0 ? await storage.remove(oldObjectKeys) : { error: null };
      if (removeOldObjects.error) {
        cleanupWarning = true;
      } else {
        const oldResumeIds = replacedRows.map((resumeRow) => resumeRow.id).filter((id): id is string => typeof id === "string");
        const deleteOldRows = oldResumeIds.length > 0
          ? await supabase.from("resumes").delete().eq("user_id", userId).in("id", oldResumeIds)
          : { error: null };
        cleanupWarning = Boolean(deleteOldRows.error);
      }
    }
    sendSavedResume(newResume, cleanupWarning);
  } catch {
    let reconciledRow: unknown = null;
    let reconciliationFailed = false;
    try {
      const reconciliation = await supabase.from("resumes")
        .select("id, display_name, original_file_name, file_size_bytes, sha256, is_default, created_at")
        .eq("user_id", userId)
        .eq("object_key", objectKey)
        .maybeSingle();
      reconciledRow = reconciliation.data;
      reconciliationFailed = Boolean(reconciliation.error);
    } catch {
      reconciliationFailed = true;
    }
    if (isRecord(reconciledRow)) {
      sendSavedResume(reconciledRow, true);
      return;
    }
    if (objectUploaded && !replacementRpcStarted && !reconciliationFailed) {
      try { await storage.remove([objectKey]); } catch { /* Best-effort cleanup after confirmed absence. */ }
    }
    response.status(503).json({ error: "Your resume could not be saved. Please try again." });
  }
});

app.get("/api/account/resume/:resumeId/download", requireHostedUser, async (request, response) => {
  const resumeId = request.params.resumeId;
  if (typeof resumeId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(resumeId)) {
    response.status(404).json({ error: "That resume was not found." });
    return;
  }
  const supabase = accountSupabase(response);
  const userId = accountUserId(response);
  try {
    const rowResult = await supabase.from("resumes")
      .select("object_key, original_file_name")
      .eq("id", resumeId)
      .eq("user_id", userId)
      .is("deleted_at", null)
      .maybeSingle();
    if (rowResult.error || !rowResult.data) {
      response.status(404).json({ error: "That resume was not found." });
      return;
    }
    const signedUrl = await supabase.storage.from("resume-files").createSignedUrl(rowResult.data.object_key, 60, {
      download: rowResult.data.original_file_name,
    });
    if (signedUrl.error || !signedUrl.data?.signedUrl) {
      response.status(503).json({ error: "The resume download is temporarily unavailable." });
      return;
    }
    response.json({ url: signedUrl.data.signedUrl });
  } catch {
    response.status(503).json({ error: "The resume download is temporarily unavailable." });
  }
});

app.delete("/api/account/resume/:resumeId", requireHostedUser, requireHostedOrigin, async (request, response) => {
  const resumeId = request.params.resumeId;
  if (typeof resumeId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(resumeId)) {
    response.status(404).json({ error: "That resume was not found." });
    return;
  }
  const supabase = accountSupabase(response);
  const userId = accountUserId(response);
  try {
    const admin = getSupabaseAdminClient();
    const markDeleted = await admin.rpc("mark_hosted_resume_deleted", {
      p_user_id: userId,
      p_resume_id: resumeId,
    });
    if (markDeleted.error || !isRecord(markDeleted.data) || typeof markDeleted.data.object_key !== "string") {
      if (markDeleted.error?.code === "P0002") {
        response.status(404).json({ error: "That resume was not found." });
        return;
      }
      if (markDeleted.error?.code === "55000") {
        response.status(409).json({ error: "Wait for the active tailoring run to finish before removing this resume." });
        return;
      }
      response.status(503).json({ error: "The resume could not be prepared for removal. Apply the latest Supabase migration, then retry." });
      return;
    }
    const removeObject = await supabase.storage.from("resume-files").remove([markDeleted.data.object_key]);
    if (removeObject.error) {
      response.status(503).json({ error: "The resume could not be removed from secure storage. Retry removal from your account." });
      return;
    }
    const removeRow = await admin.from("resumes").delete().eq("id", resumeId).eq("user_id", userId);
    if (removeRow.error) {
      response.status(503).json({ error: "The resume file was removed, but its account record could not be cleared. Retry removal from your account." });
      return;
    }
    response.status(204).end();
  } catch {
    response.status(503).json({ error: "The resume could not be removed. Please try again." });
  }
});

app.get("/api/auth/chatgpt", async (request, response) => {
  if (isHostedMode()) {
    response.status(404).json({ error: "The local ChatGPT connection is not available in hosted mode." });
    return;
  }
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
  if (isHostedMode()) {
    response.status(404).send("Not found");
    return;
  }
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
  if (isHostedMode()) {
    response.status(503).json({ error: "Tailored resume downloads are not enabled until hosted tailoring is ready." });
    return;
  }
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

app.use("/api", (_request, response) => {
  response.status(404).json({ error: "API route not found." });
});

app.use((error: Error, _request: Request, response: Response, _next: NextFunction) => {
  const bodyStatus = (error as Error & { status?: number }).status;
  if (bodyStatus === 413) {
    response.status(413).json({ error: "The request body is too large." });
    return;
  }
  if (bodyStatus === 400 && error instanceof SyntaxError) {
    response.status(400).json({ error: "The request body contains invalid JSON." });
    return;
  }
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
  console.error("API request failed:", error);
  response.status(500).json({ error: "The request could not be completed. Please try again." });
});

const assetsDirectory = path.resolve(process.cwd(), "web/dist");
app.use(express.static(assetsDirectory, { index: "index.html" }));
app.get(["/settings/ai", "/results/:runId"], (_request, response) => {
  response.sendFile(path.join(assetsDirectory, "index.html"));
});

const server = app.listen(port, host, () => {
  if (isHostedMode()) {
    console.log(`TailorResume hosted service listening on ${host}:${port}`);
    console.log("Hosted account storage and Claude/OpenAI API tailoring are enabled.");
    void recoverAndStartHostedTailoring();
    void cleanExpiredHostedTailoring();
  } else {
    console.log(`TailorResume local web app: http://${host}:${port}`);
    console.log("The full job description is classified in one ChatGPT plan request; up to twelve relevant resume bullets may be included for experience drafting.");
    console.log("Temporary run files expire after one hour.");
  }
  void cleanExpiredRunDirectories();
});

const cleanupSweep = setInterval(() => void cleanExpiredRunDirectories(), 5 * 60 * 1000);
cleanupSweep.unref();
const hostedQueueSweep = setInterval(() => queueHostedTailoring(), 5 * 1000);
hostedQueueSweep.unref();
const hostedRetentionSweep = setInterval(() => void cleanExpiredHostedTailoring(), 60 * 60 * 1000);
hostedRetentionSweep.unref();

async function cleanRuns(): Promise<void> {
  clearInterval(cleanupSweep);
  clearInterval(hostedQueueSweep);
  clearInterval(hostedRetentionSweep);
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
