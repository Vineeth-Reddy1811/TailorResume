import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import type { AuthenticatedAppUser, HostedAccountResponse, HostedProviderConnection, HostedResumeRecord, HostedTailoringRunState } from "../../shared/api";
import ReviewPanel from "./ReviewPanel";

const emptyProfile = { facts: [], verifiedSkills: [] };
const maximumProfileBytes = 1024 * 1024;

interface HostedWorkspaceProps {
  user: AuthenticatedAppUser;
  authBusy: boolean;
  themeMode: "system" | "light" | "dark";
  onSignOut: () => void;
  onCycleTheme: () => void;
}

function isProfile(value: unknown): value is Record<string, unknown> & { facts: unknown[]; verifiedSkills: unknown[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate.facts) && Array.isArray(candidate.verifiedSkills);
}

function messageFrom(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string") return payload.error;
  return fallback;
}

export default function HostedWorkspace({ user, authBusy, themeMode, onSignOut, onCycleTheme }: HostedWorkspaceProps) {
  const [account, setAccount] = useState<HostedAccountResponse | null>(null);
  const [providerConnections, setProviderConnections] = useState<HostedProviderConnection[]>([]);
  const [providerModels, setProviderModels] = useState<Record<"anthropic" | "xai", Array<{ id: string; name: string }>>>({ anthropic: [], xai: [] });
  const [selectedModelDraft, setSelectedModelDraft] = useState<Record<"anthropic" | "xai", string>>({ anthropic: "", xai: "" });
  const [editingModel, setEditingModel] = useState<"anthropic" | "xai" | null>(null);
  const [loadingModels, setLoadingModels] = useState<"anthropic" | "xai" | null>(null);
  const [savingModel, setSavingModel] = useState<"anthropic" | "xai" | null>(null);
  const [providerKeys, setProviderKeys] = useState<Record<"anthropic" | "xai", string>>({ anthropic: "", xai: "" });
  const [savingProvider, setSavingProvider] = useState<"anthropic" | "xai" | null>(null);
  const [profileText, setProfileText] = useState(JSON.stringify(emptyProfile, null, 2));
  const [loading, setLoading] = useState(true);
  const [savingProfile, setSavingProfile] = useState(false);
  const [uploadingResume, setUploadingResume] = useState(false);
  const [accountError, setAccountError] = useState("");
  const [accountNotice, setAccountNotice] = useState("");
  const [profileFileName, setProfileFileName] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [aiConsent, setAiConsent] = useState(false);
  const [tailoring, setTailoring] = useState(false);
  const [hostedRun, setHostedRun] = useState<HostedTailoringRunState | null>(null);

  async function refreshAccount(): Promise<void> {
    const response = await fetch("/api/account", { cache: "no-store", credentials: "same-origin" });
    const payload = await response.json() as HostedAccountResponse & { error?: string };
    if (!response.ok) throw new Error(messageFrom(payload, "Your cloud account data could not be loaded."));
    if (!isProfile(payload.experienceProfile)) throw new Error("Supabase returned an invalid experience profile. Check the account migration.");
    setAccount(payload);
    setProfileText(JSON.stringify(payload.experienceProfile, null, 2));
  }

  async function refreshProviders(): Promise<void> {
    const response = await fetch("/api/account/providers", { cache: "no-store", credentials: "same-origin" });
    const payload = await response.json() as { connections?: HostedProviderConnection[]; error?: string };
    if (!response.ok) throw new Error(messageFrom(payload, "AI provider connections could not be loaded."));
    setProviderConnections(Array.isArray(payload.connections) ? payload.connections : []);
  }

  useEffect(() => {
    let active = true;
    Promise.all([
      fetch("/api/account", { cache: "no-store", credentials: "same-origin" }).then(async (response) => {
        const payload = await response.json() as HostedAccountResponse & { error?: string };
        if (!response.ok) throw new Error(messageFrom(payload, "Your cloud account data could not be loaded."));
        if (!isProfile(payload.experienceProfile)) throw new Error("Supabase returned an invalid experience profile.");
        if (!active) return;
        setAccount(payload);
        setProfileText(JSON.stringify(payload.experienceProfile, null, 2));
      }),
      fetch("/api/account/providers", { cache: "no-store", credentials: "same-origin" }).then(async (response) => {
        const payload = await response.json() as { connections?: HostedProviderConnection[]; error?: string };
        if (!response.ok) throw new Error(messageFrom(payload, "AI provider connections could not be loaded."));
        if (active) setProviderConnections(Array.isArray(payload.connections) ? payload.connections : []);
      }),
    ])
      .catch((error: unknown) => {
        if (active) setAccountError(error instanceof Error ? error.message : "Your cloud account data could not be loaded.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!hostedRun || !["queued", "running"].includes(hostedRun.status)) return;
    let active = true;
    let timer = 0;
    const poll = async () => {
      try {
        const response = await fetch(`/api/account/runs/${encodeURIComponent(hostedRun.runId)}`, { cache: "no-store", credentials: "same-origin" });
          const payload = await response.json() as { run?: HostedTailoringRunState; error?: string };
          if (!response.ok) throw new Error(messageFrom(payload, "The tailoring run could not be checked."));
          if (active && payload.run) setHostedRun(payload.run);
      } catch (error) {
        if (active) setAccountError(error instanceof Error ? error.message : "The tailoring run could not be checked.");
      } finally {
        if (active) timer = window.setTimeout(() => void poll(), 2000);
      }
    };
    timer = window.setTimeout(() => void poll(), 1500);
    return () => { active = false; window.clearTimeout(timer); };
  }, [hostedRun]);

  useEffect(() => {
    let active = true;
    void fetch("/api/account/runs/latest", { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => {
        if (response.status === 404) return null;
        const payload = await response.json() as { run?: HostedTailoringRunState; error?: string };
        if (!response.ok) throw new Error(messageFrom(payload, "Your latest tailoring run could not be loaded."));
        return payload.run ?? null;
      })
      .then((run) => { if (active && run) setHostedRun(run); })
      .catch((error: unknown) => { if (active) setAccountError(error instanceof Error ? error.message : "Your latest tailoring run could not be loaded."); });
    return () => { active = false; };
  }, []);

  async function loadProfileFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    setAccountError("");
    setAccountNotice("");
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".json") || file.size > maximumProfileBytes) {
      setAccountError("Choose a JSON experience profile no larger than 1 MB.");
      return;
    }
    try {
      const text = await file.text();
      const profile = JSON.parse(text) as unknown;
      if (!isProfile(profile)) throw new Error("The file must contain facts and verifiedSkills arrays.");
      setProfileText(JSON.stringify(profile, null, 2));
      setProfileFileName(file.name);
      setAccountNotice(`${file.name} loaded. Save the profile to store it in your account.`);
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "The profile file could not be read.");
    }
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setAccountError("");
    setAccountNotice("");
    let profileData: unknown;
    try {
      profileData = JSON.parse(profileText);
    } catch {
      setAccountError("The experience profile is not valid JSON.");
      return;
    }
    if (!isProfile(profileData)) {
      setAccountError("The profile must be a JSON object with facts and verifiedSkills arrays.");
      return;
    }
    if (new TextEncoder().encode(profileText).byteLength > maximumProfileBytes) {
      setAccountError("Keep the experience profile at or below 1 MB of UTF-8 data.");
      return;
    }
    setSavingProfile(true);
    try {
      const response = await fetch("/api/account/experience-profile", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileData }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(messageFrom(payload, "The experience profile could not be saved."));
      await refreshAccount();
      setProfileFileName("");
      setAccountNotice("Experience profile saved to your account.");
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "The experience profile could not be saved.");
    } finally {
      setSavingProfile(false);
    }
  }

  async function saveProvider(provider: "anthropic" | "xai", event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const apiKey = providerKeys[provider];
    setAccountError("");
    setAccountNotice("");
    if (apiKey.length < 20 || apiKey.length > 500 || /\s/.test(apiKey)) {
      setAccountError("Enter a provider API key between 20 and 500 characters, without spaces.");
      return;
    }
    setSavingProvider(provider);
    try {
      const response = await fetch(`/api/account/providers/${provider}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string; models?: Array<{ id: string; name: string }>; selectedModel?: string };
      if (!response.ok) throw new Error(messageFrom(payload, "The provider key could not be saved."));
      setProviderKeys((current) => ({ ...current, [provider]: "" }));
      setProviderModels((current) => ({ ...current, [provider]: Array.isArray(payload.models) ? payload.models : [] }));
      setSelectedModelDraft((current) => ({ ...current, [provider]: payload.selectedModel ?? "" }));
      await refreshProviders();
      setAccountNotice(`${provider === "anthropic" ? "Claude" : "Grok"} key verified and saved encrypted to your account.`);
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "The provider key could not be saved.");
    } finally {
      setSavingProvider(null);
    }
  }

  async function loadProviderModels(provider: "anthropic" | "xai"): Promise<void> {
    setAccountError("");
    setAccountNotice("");
    setLoadingModels(provider);
    try {
      const response = await fetch(`/api/account/providers/${provider}/models`, { cache: "no-store", credentials: "same-origin" });
      const payload = await response.json() as { error?: string; models?: Array<{ id: string; name: string }>; selectedModel?: string | null };
      if (!response.ok) throw new Error(messageFrom(payload, "Available models could not be loaded."));
      const models = Array.isArray(payload.models) ? payload.models : [];
      setProviderModels((current) => ({ ...current, [provider]: models }));
      setSelectedModelDraft((current) => ({ ...current, [provider]: payload.selectedModel ?? "" }));
      setEditingModel(provider);
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "Available models could not be loaded.");
    } finally {
      setLoadingModels(null);
    }
  }

  async function saveProviderModel(provider: "anthropic" | "xai"): Promise<void> {
    const modelId = selectedModelDraft[provider];
    if (!modelId) {
      setAccountError("Choose a model before saving.");
      return;
    }
    setAccountError("");
    setAccountNotice("");
    setSavingModel(provider);
    try {
      const response = await fetch(`/api/account/providers/${provider}/model`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string; selectedModel?: string };
      if (!response.ok) throw new Error(messageFrom(payload, "The model selection could not be saved."));
      await refreshProviders();
      setEditingModel(null);
      setAccountNotice(`${provider === "anthropic" ? "Claude" : "Grok"} model selection saved.`);
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "The model selection could not be saved.");
    } finally {
      setSavingModel(null);
    }
  }

  async function removeProvider(provider: "anthropic" | "xai"): Promise<void> {
    if (!window.confirm(`Remove the saved ${provider === "anthropic" ? "Claude" : "Grok"} API key?`)) return;
    setAccountError("");
    setAccountNotice("");
    try {
      const response = await fetch(`/api/account/providers/${provider}`, { method: "DELETE", credentials: "same-origin" });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(messageFrom(payload, "The provider key could not be removed."));
      await refreshProviders();
      setAccountNotice("The saved provider key was removed.");
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "The provider key could not be removed.");
    }
  }

  async function submitHostedRun(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setAccountError("");
    setAccountNotice("");
    const provider = providerConnections.find((item) => item.provider === "anthropic" && item.selected_model);
    if (!currentResume) {
      setAccountError("Save a base resume before tailoring.");
      return;
    }
    if (!provider) {
      setAccountError("Connect Claude and select a supported model before tailoring.");
      return;
    }
    if (!jobDescription.trim() || jobDescription.length > 30_000) {
      setAccountError("Paste a job description up to 30,000 characters.");
      return;
    }
    if (!aiConsent) {
      setAccountError("Confirm the AI data-sharing notice before starting the run.");
      return;
    }
    setTailoring(true);
    try {
      const response = await fetch("/api/account/runs", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobDescription: jobDescription.trim(), provider: "anthropic", aiConsent: true }),
      });
      const payload = await response.json() as { run?: HostedTailoringRunState; error?: string };
      if (!response.ok || !payload.run) throw new Error(messageFrom(payload, "The tailoring run could not be started."));
      setHostedRun(payload.run);
      setAccountNotice("Tailoring started. You can keep this page open while the result is prepared.");
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "The tailoring run could not be started.");
    } finally {
      setTailoring(false);
    }
  }

  async function deleteHostedRun(): Promise<void> {
    if (!hostedRun || !window.confirm("Delete this tailoring run and its generated resume?")) return;
    setAccountError("");
    try {
      const response = await fetch(`/api/account/runs/${encodeURIComponent(hostedRun.runId)}`, { method: "DELETE", credentials: "same-origin" });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(messageFrom(payload, "The tailoring run could not be deleted."));
      setHostedRun(null);
      setAccountNotice("The tailoring run and generated resume were deleted.");
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "The tailoring run could not be deleted.");
    }
  }

  async function uploadResume(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    setAccountError("");
    setAccountNotice("");
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".docx") || file.size < 4 || file.size > 15 * 1024 * 1024) {
      setAccountError("Choose a DOCX resume between 4 bytes and 15 MB.");
      return;
    }
    setUploadingResume(true);
    try {
      const form = new FormData();
      form.append("resume", file);
      const response = await fetch("/api/account/resume", { method: "POST", credentials: "same-origin", body: form });
      const payload = await response.json() as { error?: string; cleanupWarning?: boolean };
      if (!response.ok) throw new Error(messageFrom(payload, "The resume could not be uploaded."));
      await refreshAccount();
      setAccountNotice(payload.cleanupWarning
        ? "The new base resume is saved. An older resume copy could not be cleaned up yet."
        : "Your base resume is saved securely to your account.");
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "The resume could not be uploaded.");
    } finally {
      setUploadingResume(false);
    }
  }

  async function downloadResume(resume: HostedResumeRecord): Promise<void> {
    setAccountError("");
    try {
      const response = await fetch(`/api/account/resume/${encodeURIComponent(resume.id)}/download`, { cache: "no-store", credentials: "same-origin" });
      const payload = await response.json() as { url?: string; error?: string };
      if (!response.ok || !payload.url) throw new Error(messageFrom(payload, "The resume download is unavailable."));
      window.location.assign(payload.url);
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "The resume download is unavailable.");
    }
  }

  async function removeResume(resume: HostedResumeRecord): Promise<void> {
    if (!window.confirm("Remove this saved resume from your account?")) return;
    setAccountError("");
    setAccountNotice("");
    try {
      const response = await fetch(`/api/account/resume/${encodeURIComponent(resume.id)}`, { method: "DELETE", credentials: "same-origin" });
      if (!response.ok) {
        const payload = await response.json() as { error?: string };
        throw new Error(messageFrom(payload, "The resume could not be removed."));
      }
      await refreshAccount();
      setAccountNotice("The resume was removed from your account.");
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "The resume could not be removed.");
    }
  }

  const currentResume = account?.resumes.find((resume) => resume.is_default) ?? null;

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="TailorResume home">
          <span className="brand-mark" aria-hidden="true">T</span>
          <span>tailor<span className="brand-light">resume</span></span>
        </a>
        <div className="topbar-actions">
          <button className="theme-toggle" type="button" onClick={onCycleTheme} aria-label={`Theme setting: ${themeMode}. Activate to change theme`} title="Cycles between system, light, and dark themes">
            <span aria-hidden="true">{themeMode === "dark" ? "☾" : themeMode === "light" ? "☀" : "◐"}</span>
            <span>{themeMode === "system" ? "System" : themeMode === "light" ? "Light" : "Dark"}</span>
          </button>
          <button className="secondary-button" type="button" onClick={onSignOut} disabled={authBusy}>{authBusy ? "Signing out…" : "Sign out"}</button>
        </div>
      </header>

      <main id="top" className="main-content hosted-main">
        <section className="intro" aria-labelledby="hosted-title">
          <p className="eyebrow">RESUME WORKSPACE <span>·</span> HOSTED ACCOUNT</p>
          <h1 id="hosted-title">Your private resume workspace.</h1>
          <p className="intro-copy">Signed in as {user.displayName || user.email || "your Google account"}. Your resume and experience profile are stored in your account.</p>
        </section>

        {accountError && <div className="error-message hosted-feedback" role="alert"><span aria-hidden="true">!</span>{accountError}</div>}
        {accountNotice && <div className="account-notice hosted-feedback" role="status">{accountNotice}</div>}

        <section className="hosted-card" aria-labelledby="base-resume-title">
          <div className="panel-heading">
            <div><span className="step-label">01 / BASE RESUME</span><h2 id="base-resume-title">Your resume</h2></div>
            <span className="field-meta">DOCX · up to 15 MB</span>
          </div>
          {loading ? <p className="intro-copy">Loading your saved resume…</p> : currentResume ? (
            <div className="hosted-resume-row">
              <div className="hosted-resume-copy">
                <strong>{currentResume.original_file_name}</strong>
                <span>{(Number(currentResume.file_size_bytes) / 1024).toFixed(0)} KB · saved {new Date(currentResume.created_at).toLocaleDateString()}</span>
              </div>
              <div className="hosted-resume-actions">
                <button className="secondary-button" type="button" onClick={() => void downloadResume(currentResume)}>Download</button>
                <button className="text-button hosted-remove-button" type="button" onClick={() => void removeResume(currentResume)}>Remove</button>
              </div>
            </div>
          ) : <p className="hosted-empty-state">No base resume saved yet. Upload your DOCX to keep it with this account.</p>}
          <label className="primary-button hosted-upload-button">
            {uploadingResume ? "Saving resume…" : currentResume ? "Replace base resume" : "Upload base resume"}
            <input className="visually-hidden" type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" disabled={uploadingResume} onChange={(event) => void uploadResume(event)} />
          </label>
        </section>

        <section className="hosted-card" aria-labelledby="profile-title">
          <div className="panel-heading">
            <div><span className="step-label">02 / EXPERIENCE PROFILE</span><h2 id="profile-title">Your verified experience</h2></div>
            {profileFileName && <span className="field-meta">Loaded: {profileFileName}</span>}
          </div>
          <p className="hosted-help-copy">Import your existing <code>experience-profile.json</code> or edit the JSON below. Keep facts and skills accurate; this becomes the source for future tailored resumes.</p>
          <div className="hosted-profile-actions">
            <label className="secondary-button hosted-upload-button">
              Load profile JSON
              <input className="visually-hidden" type="file" accept=".json,application/json" onChange={(event) => void loadProfileFile(event)} />
            </label>
            {account?.experienceProfileUpdatedAt && <span className="field-meta">Saved {new Date(account.experienceProfileUpdatedAt).toLocaleString()}</span>}
          </div>
          <form onSubmit={(event) => void saveProfile(event)}>
            <label className="visually-hidden" htmlFor="hosted-profile-json">Experience profile JSON</label>
            <textarea id="hosted-profile-json" className="hosted-profile-editor" value={profileText} maxLength={maximumProfileBytes} spellCheck={false} onChange={(event) => setProfileText(event.target.value)} />
            <div className="hosted-profile-footer">
              <span className="field-meta">JSON · up to 1 MB</span>
              <button className="primary-button" type="submit" disabled={savingProfile || loading}>{savingProfile ? "Saving profile…" : "Save experience profile"}</button>
            </div>
          </form>
        </section>

        <section className="hosted-card" aria-labelledby="providers-title">
          <div className="panel-heading">
            <div><span className="step-label">03 / AI PROVIDERS</span><h2 id="providers-title">Your provider keys</h2></div>
            <span className="field-meta">Bring your own API key</span>
          </div>
          <p className="hosted-help-copy">Keys are encrypted by the server before they are saved and are never returned to the browser. Saving a key checks the provider’s model catalogue; it does not send your resume or job description. You can choose which available text model to use when hosted tailoring is enabled.</p>
          {(["anthropic", "xai"] as const).map((provider) => {
            const connection = providerConnections.find((item) => item.provider === provider);
            const connected = Boolean(connection);
            const label = provider === "anthropic" ? "Claude" : "Grok";
            return (
              <form className="hosted-provider-row" key={provider} onSubmit={(event) => void saveProvider(provider, event)}>
                <div className="hosted-provider-heading">
                  <div><strong>{label}</strong><span>{connection?.last_verified_at ? `Key verified ${new Date(connection.last_verified_at).toLocaleDateString()}` : connected ? "Key saved · not yet verified" : "No key saved"}</span></div>
                  {connected && <button className="text-button hosted-remove-button" type="button" onClick={() => void removeProvider(provider)}>Remove key</button>}
                </div>
                <label className="visually-hidden" htmlFor={`${provider}-api-key`}>{label} API key</label>
                <input
                  id={`${provider}-api-key`}
                  className="hosted-provider-input"
                  type="password"
                  autoComplete="new-password"
                  value={providerKeys[provider]}
                  onChange={(event) => setProviderKeys((current) => ({ ...current, [provider]: event.target.value }))}
                  placeholder={connected ? "Enter a replacement key" : "Paste your API key"}
                  minLength={20}
                  maxLength={500}
                />
                <div className="hosted-provider-footer">
                  <span className="field-meta">Provider usage is billed by {provider === "anthropic" ? "Anthropic" : "xAI"}.</span>
                  <button className="secondary-button" type="submit" disabled={savingProvider !== null || providerKeys[provider].length < 20}>{savingProvider === provider ? "Saving…" : connected ? "Replace key" : "Save key"}</button>
                </div>
                {connected && <div className="hosted-model-selection">
                  <span className="field-meta">Selected model: <strong>{connection?.selected_model ?? "Not selected"}</strong></span>
                  {editingModel !== provider
                    ? <button className="text-button" type="button" disabled={loadingModels !== null} onClick={() => void loadProviderModels(provider)}>{loadingModels === provider ? "Loading models…" : "Change model"}</button>
                    : <div className="hosted-model-editor">
                      <label className="visually-hidden" htmlFor={`${provider}-model`}>{label} model</label>
                      <select id={`${provider}-model`} className="hosted-provider-input" value={selectedModelDraft[provider]} onChange={(event) => setSelectedModelDraft((current) => ({ ...current, [provider]: event.target.value }))}>
                        <option value="" disabled>Choose an available model</option>
                        {providerModels[provider].map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
                      </select>
                      <div className="hosted-provider-footer">
                        <button className="secondary-button" type="button" disabled={savingModel !== null || !selectedModelDraft[provider]} onClick={() => void saveProviderModel(provider)}>{savingModel === provider ? "Saving…" : "Save model"}</button>
                        <button className="text-button" type="button" disabled={savingModel === provider} onClick={() => setEditingModel(null)}>Cancel</button>
                      </div>
                    </div>}
                </div>}
              </form>
            );
          })}
        </section>

        <section className="hosted-card" aria-labelledby="hosted-tailor-title">
          <div className="panel-heading">
            <div><span className="step-label">04 / TAILOR A RESUME</span><h2 id="hosted-tailor-title">Match your resume to a job</h2></div>
            <span className="field-meta">Claude · saved model</span>
          </div>
          <p className="hosted-help-copy">The full job description and up to 12 relevant experience bullets are sent to Anthropic for analysis. Your DOCX and experience profile stay in TailorResume. Runs and generated files are stored in your account for up to 30 days.</p>
          {!currentResume && <p className="hosted-empty-state">Upload a base resume above to begin.</p>}
          {!providerConnections.some((item) => item.provider === "anthropic" && item.selected_model) && <p className="hosted-empty-state">Connect a Claude API key and select a model above to enable tailoring.</p>}
          <form className="hosted-tailoring-form" onSubmit={(event) => void submitHostedRun(event)}>
            <label htmlFor="hosted-job-description">Job description</label>
            <textarea id="hosted-job-description" className="hosted-job-description" value={jobDescription} maxLength={30_000} onChange={(event) => setJobDescription(event.target.value)} placeholder="Paste the full job description" required />
            <span className="field-meta">{jobDescription.length.toLocaleString()} / 30,000 characters · Provider and model are configured above.</span>
            <label className="hosted-consent-row">
              <input type="checkbox" checked={aiConsent} onChange={(event) => setAiConsent(event.target.checked)} />
              <span>I agree to send the job description and relevant resume experience bullets to Anthropic for this run.</span>
            </label>
            <button className="primary-button" type="submit" disabled={tailoring || !currentResume || !providerConnections.some((item) => item.provider === "anthropic" && item.selected_model) || !aiConsent || !jobDescription.trim()}>{tailoring ? "Starting…" : "Tailor resume"}</button>
          </form>
          {hostedRun && <div className="hosted-run-status" role="status" aria-live="polite">
            <div><strong>{hostedRun.status === "queued" ? "Queued" : hostedRun.status === "running" ? "Preparing your resume…" : hostedRun.status === "succeeded" ? "Resume ready" : hostedRun.status === "failed" ? "Run failed" : hostedRun.status}</strong><span>{new Date(hostedRun.createdAt).toLocaleString()} · {hostedRun.provider ?? "Claude"}{hostedRun.model ? ` · ${hostedRun.model}` : ""}</span></div>
            {(hostedRun.status === "failed" || hostedRun.status === "canceled") && hostedRun.error && <p>{hostedRun.error}</p>}
            {!(["queued", "running"].includes(hostedRun.status)) && <button className="text-button hosted-remove-button" type="button" onClick={() => void deleteHostedRun()}>Delete this run</button>}
          </div>}
        </section>

        {hostedRun?.result && <section className="hosted-card hosted-run-result" aria-label="Tailoring result">
          <ReviewPanel result={hostedRun.result} retentionCopy="This hosted result and generated file expire after 30 days. You can delete them sooner." />
        </section>}

        <div className="account-notice hosted-rollout-notice" role="status">
          Your resumes, profile, provider settings, and tailoring runs belong to this account. Hosted tailoring currently supports Claude; Grok support is planned next. This account does not use the local ChatGPT connection.
        </div>
      </main>
      <footer className="page-footer"><span>TAILORRESUME</span><span>Private hosted workspace</span></footer>
    </div>
  );
}
