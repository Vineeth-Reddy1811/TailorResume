import { createHash, randomBytes, randomUUID } from "crypto";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { createRemoteJWKSet, jwtVerify } from "jose";

const authBase = "https://auth.openai.com";
const tokenEndpoint = `${authBase}/api/accounts/oauth/token`;
const authorizeEndpoint = `${authBase}/api/accounts/authorize`;
const resource = "https://api.openai.com/v1";
const issuer = authBase;
const callbackPath = "/auth/callback";
const transactionLifetimeMs = 10 * 60 * 1000;
const requiredPlanScope = "chatgpt.tokens.use.direct";
const scopes = ["openid", "profile", "email", "offline_access", "resource.invoke", requiredPlanScope].join(" ");
const storageDirectory = path.join(os.homedir(), ".config", "tailorresume");
const credentialsPath = path.join(storageDirectory, "chatgpt-credentials.json");
const jwks = createRemoteJWKSet(new URL(`${authBase}/.well-known/jwks.json`));

interface Credentials {
  hostId: string;
  clientId?: string;
  subject?: string;
  email?: string;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt?: number;
  scopes?: string[];
}

interface SignInTransaction {
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  clientId?: string;
  subject?: string;
  returnOrigin: string;
  createdAt: number;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  error?: unknown;
}

const transactions = new Map<string, SignInTransaction>();
let refreshInFlight: Promise<string> | undefined;
let modelCache: { expiresAt: number; models: string[] } | undefined;
let credentialGeneration = 0;
let disconnectPending = false;
let credentialWriteQueue: Promise<void> = Promise.resolve();
let generatedHostId: string | undefined;

function randomValue(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

async function readCredentials(): Promise<Credentials> {
  const fileInfo = await fs.lstat(credentialsPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!fileInfo) {
    generatedHostId ??= `urn:uuid:${randomUUID()}`;
    return { hostId: generatedHostId };
  }
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
    throw new Error("The local ChatGPT credential file is not a regular file. Move it and reconnect ChatGPT.");
  }
  if (typeof process.getuid === "function" && fileInfo.uid !== process.getuid()) {
    throw new Error("The local ChatGPT credential file has an unexpected owner. Move it and reconnect ChatGPT.");
  }
  if (process.platform !== "win32" && (fileInfo.mode & 0o077) !== 0) {
    await fs.chmod(credentialsPath, 0o600);
  }
  const value = JSON.parse(await fs.readFile(credentialsPath, "utf8")) as Partial<Credentials>;
  if (typeof value.hostId !== "string" || !value.hostId.startsWith("urn:uuid:")) {
    throw new Error("Local ChatGPT credentials are invalid. Disconnect and connect ChatGPT again.");
  }
  return value as Credentials;
}

async function writeCredentials(credentials: Credentials, expectedGeneration = credentialGeneration): Promise<void> {
  const write = credentialWriteQueue.then(async () => {
    if (expectedGeneration !== credentialGeneration) throw new Error("ChatGPT connection changed while credentials were updating. Retry the operation.");
    await fs.mkdir(storageDirectory, { recursive: true, mode: 0o700 });
    await fs.chmod(storageDirectory, 0o700).catch(() => undefined);
    const temporaryPath = `${credentialsPath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(credentials, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await fs.rename(temporaryPath, credentialsPath);
      await fs.chmod(credentialsPath, 0o600).catch(() => undefined);
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  });
  credentialWriteQueue = write.then(() => undefined, () => undefined);
  return write;
}

function scopesFrom(value: unknown): string[] {
  return typeof value === "string" ? value.split(/\s+/).filter(Boolean) : [];
}

function tokenString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 8) throw new Error(`ChatGPT did not return a valid ${label}. Please try connecting again.`);
  return value;
}

async function exchangeToken(parameters: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: parameters,
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => null) as TokenResponse | null;
  if (!response.ok || !payload) {
    const code = typeof payload?.error === "string" ? payload.error : "token_exchange_failed";
    throw new Error(`ChatGPT sign-in failed (${code}). Please start a new connection attempt.`);
  }
  return payload;
}

export async function startChatGPTSignIn(returnOrigin: string, redirectUri: string): Promise<string> {
  if (disconnectPending) throw new Error("Wait for ChatGPT to finish disconnecting before reconnecting.");
  for (const [state, transaction] of transactions) {
    if (Date.now() - transaction.createdAt > transactionLifetimeMs) transactions.delete(state);
  }
  if (transactions.size >= 5) throw new Error("A ChatGPT sign-in is already pending. Return to TailorResume and try again shortly.");
  const credentials = await readCredentials();
  if (!await fs.lstat(credentialsPath).then(() => true, () => false)) await writeCredentials(credentials);
  const state = randomValue();
  const nonce = randomValue();
  const verifier = randomValue(48);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const transaction: SignInTransaction = {
    state,
    nonce,
    verifier,
    redirectUri,
    ...(credentials.clientId ? { clientId: credentials.clientId } : {}),
    ...(credentials.subject ? { subject: credentials.subject } : {}),
    returnOrigin,
    createdAt: Date.now(),
  };
  transactions.set(state, transaction);

  const params = new URLSearchParams({
    client_id: credentials.clientId || "dynamic_agent_client",
    response_type: "code",
    redirect_uri: redirectUri,
    scope: scopes,
    resource,
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: challenge,
    ext_agent_host_id: credentials.hostId,
  });
  if (!credentials.clientId) params.set("agent_name_hint", "TailorResume");
  if (credentials.clientId && credentials.idToken) params.set("id_token_hint", credentials.idToken);
  if (credentials.clientId && credentials.email) params.set("login_hint", credentials.email);
  return `${authorizeEndpoint}?${params.toString()}`;
}

export async function completeChatGPTSignIn(query: URLSearchParams): Promise<string> {
  if (disconnectPending) throw new Error("ChatGPT is being disconnected. Start a new sign-in afterward.");
  const state = query.get("state") ?? "";
  const transaction = transactions.get(state);
  if (!transaction || Date.now() - transaction.createdAt > transactionLifetimeMs) {
    if (transaction) transactions.delete(state);
    throw new Error("This ChatGPT sign-in expired or could not be verified. Start again from TailorResume.");
  }
  transactions.delete(state);
  const generation = credentialGeneration;

  const oauthError = query.get("error");
  if (oauthError) throw new Error(oauthError === "access_denied"
    ? "ChatGPT plan permission was not granted. TailorResume needs that permission to run AI drafting."
    : "ChatGPT sign-in was not completed. Please try again.");

  const code = query.get("code");
  if (!code) throw new Error("ChatGPT did not return an authorization code. Start again from TailorResume.");
  const callbackClientId = query.get("client_id");
  if (transaction.clientId && callbackClientId && callbackClientId !== transaction.clientId) {
    throw new Error("The ChatGPT account registration did not match this sign-in attempt. Start again.");
  }
  const clientId = transaction.clientId ?? callbackClientId;
  if (!clientId || clientId === "dynamic_agent_client") {
    throw new Error("ChatGPT did not finish registering TailorResume. Start a new connection attempt.");
  }

  const tokenResponse = await exchangeToken(new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    code_verifier: transaction.verifier,
    redirect_uri: transaction.redirectUri,
    resource,
  }));
  const idToken = tokenString(tokenResponse.id_token, "identity token");
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer,
    audience: clientId,
  });
  if (payload.nonce !== transaction.nonce) throw new Error("ChatGPT identity could not be matched to this sign-in attempt.");
  if (typeof payload.sub !== "string" || !payload.sub) throw new Error("ChatGPT returned an invalid account identity.");
  if (transaction.subject && payload.sub !== transaction.subject) {
    throw new Error("The signed-in ChatGPT account changed. Connect that account as a new account instead.");
  }

  const grantedScopes = scopesFrom(tokenResponse.scope);
  if (!grantedScopes.includes(requiredPlanScope)) {
    throw new Error("ChatGPT sign-in succeeded, but plan usage permission was not granted. Reconnect and allow ChatGPT plan usage.");
  }
  const accessToken = tokenString(tokenResponse.access_token, "access token");
  const refreshToken = tokenString(tokenResponse.refresh_token, "refresh token");
  const expiresIn = typeof tokenResponse.expires_in === "number" ? tokenResponse.expires_in : 3600;
  const prior = await readCredentials();
  await writeCredentials({
    hostId: prior.hostId,
    clientId,
    subject: payload.sub,
    ...(typeof payload.email === "string" ? { email: payload.email } : {}),
    accessToken,
    refreshToken,
    idToken,
    expiresAt: Date.now() + expiresIn * 1000,
    scopes: grantedScopes,
  }, generation);
  modelCache = undefined;
  return transaction.returnOrigin;
}

async function refreshAccessToken(credentials: Credentials, generation: number): Promise<string> {
  if (!credentials.clientId || !credentials.refreshToken) {
    throw new Error("Connect ChatGPT before tailoring a resume. No API key is used by this app.");
  }
  const response = await exchangeToken(new URLSearchParams({
    grant_type: "refresh_token",
    client_id: credentials.clientId,
    refresh_token: credentials.refreshToken,
    resource,
  }));
  const updated: Credentials = {
    ...credentials,
    accessToken: tokenString(response.access_token, "access token"),
    refreshToken: typeof response.refresh_token === "string" ? response.refresh_token : credentials.refreshToken,
    expiresAt: Date.now() + (typeof response.expires_in === "number" ? response.expires_in : 3600) * 1000,
    scopes: scopesFrom(response.scope).length ? scopesFrom(response.scope) : credentials.scopes,
  };
  if (!updated.scopes?.includes(requiredPlanScope)) throw new Error("ChatGPT plan permission expired. Reconnect ChatGPT in TailorResume.");
  await writeCredentials(updated, generation);
  return updated.accessToken!;
}

export async function getChatGPTAccessToken(): Promise<string> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      if (disconnectPending) throw new Error("ChatGPT is disconnecting. Retry after the connection is cleared.");
      const generation = credentialGeneration;
      const credentials = await readCredentials();
      if (generation !== credentialGeneration || disconnectPending) throw new Error("ChatGPT connection changed while preparing the request. Please retry.");
      if (!credentials.scopes?.includes(requiredPlanScope)) {
        throw new Error("Connect ChatGPT and allow ChatGPT plan usage before tailoring a resume.");
      }
      if (credentials.accessToken && credentials.expiresAt && credentials.expiresAt > Date.now() + 60_000) {
        return credentials.accessToken;
      }
      return refreshAccessToken(credentials, generation);
    })().finally(() => { refreshInFlight = undefined; });
  }
  return refreshInFlight;
}

export async function getChatGPTModel(accessToken: string): Promise<string> {
  if (!modelCache || modelCache.expiresAt < Date.now()) {
    const response = await fetch(`${resource}/models`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Could not load models available to this ChatGPT account (HTTP ${response.status}). Reconnect ChatGPT and try again.`);
    const payload = await response.json() as { models?: Array<{ slug?: unknown; visibility?: unknown }> };
    const models = Array.isArray(payload.models)
      ? payload.models.filter((model) => model.visibility === "list" && typeof model.slug === "string").map((model) => model.slug as string)
      : [];
    if (!models.length) throw new Error("This ChatGPT account did not return any models available for plan usage.");
    modelCache = { models, expiresAt: Date.now() + 5 * 60 * 1000 };
  }
  const preferred = process.env.OPENAI_MODEL?.trim() || "gpt-6-luna";
  return preferred && modelCache.models.includes(preferred) ? preferred : modelCache.models[0];
}

export async function getChatGPTConnectionStatus(): Promise<{ connected: boolean; email?: string }> {
  const credentials = await readCredentials();
  return credentials.accessToken && credentials.refreshToken && credentials.scopes?.includes(requiredPlanScope)
    ? { connected: true, ...(credentials.email ? { email: credentials.email } : {}) }
    : { connected: false };
}

export async function disconnectChatGPT(): Promise<boolean> {
  if (disconnectPending) throw new Error("ChatGPT is already disconnecting.");
  disconnectPending = true;
  credentialGeneration += 1;
  transactions.clear();
  try {
    const credentials = await readCredentials();
    if (!credentials.refreshToken || !credentials.clientId) {
      const hadTokens = Boolean(credentials.accessToken || credentials.refreshToken || credentials.idToken);
      await writeCredentials({ hostId: credentials.hostId, ...(credentials.clientId ? { clientId: credentials.clientId } : {}) });
      modelCache = undefined;
      return !hadTokens;
    }
    let revoked = false;
    try {
      const discoveryResponse = await fetch(`${authBase}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15_000) });
      const discovery = await discoveryResponse.json() as { revocation_endpoint?: string };
      const revocationUrl = discovery.revocation_endpoint ? new URL(discovery.revocation_endpoint) : undefined;
      if (discoveryResponse.ok && revocationUrl?.protocol === "https:" && revocationUrl.origin === authBase) {
        const response = await fetch(revocationUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: credentials.refreshToken, token_type_hint: "refresh_token", client_id: credentials.clientId }),
          signal: AbortSignal.timeout(15_000),
        });
        revoked = response.ok;
      }
    } catch {
      revoked = false;
    }
    await writeCredentials({ hostId: credentials.hostId, clientId: credentials.clientId });
    modelCache = undefined;
    return revoked;
  } finally {
    disconnectPending = false;
  }
}

export function chatGPTCallbackPath(): string {
  return callbackPath;
}
