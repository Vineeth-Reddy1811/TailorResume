import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import type { AuthenticatedAppUser, HostedAccountResponse, HostedProviderConnection, HostedResumeRecord, HostedTailoringRunState, ResumeProfileView } from "../../shared/api";
import ReviewPanel from "./ReviewPanel";
import TailoringWorkspace from "./TailoringWorkspace";
import ResumeProfilePanel from "./ResumeProfilePanel";
import SkillCatalogReview from "./SkillCatalogReview";

type HostedProvider = HostedProviderConnection["provider"];
type HostedTailoringProvider = Extract<HostedProvider, "anthropic" | "openai">;
type HostedRoute = { page: "workspace" | "settings" | "results"; runId?: string };

function routeFromLocation(): HostedRoute {
  if (window.location.pathname === "/settings/ai") return { page: "settings" };
  const match = window.location.pathname.match(/^\/results\/([0-9a-f-]{36})$/i);
  if (match) return { page: "results", runId: match[1] };
  return { page: "workspace" };
}

function providerLabel(provider: HostedProvider): string {
  if (provider === "anthropic") return "Claude";
  if (provider === "xai") return "Grok";
  return "OpenAI API";
}

interface HostedWorkspaceProps {
  user: AuthenticatedAppUser;
  authBusy: boolean;
  themeMode: "system" | "light" | "dark";
  onSignOut: () => void;
  onCycleTheme: () => void;
}

function messageFrom(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string") return payload.error;
  return fallback;
}

export default function HostedWorkspace({ user, authBusy, themeMode, onSignOut, onCycleTheme }: HostedWorkspaceProps) {
  const [route, setRoute] = useState<HostedRoute>(routeFromLocation);
  const [account, setAccount] = useState<HostedAccountResponse | null>(null);
  const [resumeProfile, setResumeProfile] = useState<ResumeProfileView | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [providerConnections, setProviderConnections] = useState<HostedProviderConnection[]>([]);
  const [providerModels, setProviderModels] = useState<Record<HostedProvider, Array<{ id: string; name: string }>>>({ anthropic: [], xai: [], openai: [] });
  const [selectedModelDraft, setSelectedModelDraft] = useState<Record<HostedProvider, string>>({ anthropic: "", xai: "", openai: "" });
  const [editingModel, setEditingModel] = useState<HostedProvider | null>(null);
  const [loadingModels, setLoadingModels] = useState<HostedProvider | null>(null);
  const [savingModel, setSavingModel] = useState<HostedProvider | null>(null);
  const [providerKeys, setProviderKeys] = useState<Record<HostedProvider, string>>({ anthropic: "", xai: "", openai: "" });
  const [savingProvider, setSavingProvider] = useState<HostedProvider | null>(null);
  const [tailoringProvider, setTailoringProvider] = useState<HostedTailoringProvider>("anthropic");
  const [aiSource, setAiSource] = useState<"user" | "platform">("user");
  const [platformAccess, setPlatformAccess] = useState<{ enabled: boolean; redeemed: boolean; runsGranted: number; runsRemaining: number; model?: string }>({ enabled: false, redeemed: false, runsGranted: 0, runsRemaining: 0 });
  const [inviteCode, setInviteCode] = useState("");
  const [redeemingInvite, setRedeemingInvite] = useState(false);
  const [loading, setLoading] = useState(true);
  const [uploadingResume, setUploadingResume] = useState(false);
  const [accountError, setAccountError] = useState("");
  const [accountNotice, setAccountNotice] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [aiConsent, setAiConsent] = useState(false);
  const [tailoring, setTailoring] = useState(false);
  const [hostedRun, setHostedRun] = useState<HostedTailoringRunState | null>(null);
  const autoOpenResultRunId = useRef<string | null>(null);

  function navigateTo(path: string): void {
    window.history.pushState({}, "", path);
    setRoute(routeFromLocation());
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function refreshAccount(): Promise<void> {
    const response = await fetch("/api/account", { cache: "no-store", credentials: "same-origin" });
    const payload = await response.json() as HostedAccountResponse & { error?: string };
    if (!response.ok) throw new Error(messageFrom(payload, "Your cloud account data could not be loaded."));
    setAccount(payload);
  }

  async function refreshProviders(): Promise<void> {
    const response = await fetch("/api/account/providers", { cache: "no-store", credentials: "same-origin" });
    const payload = await response.json() as { connections?: HostedProviderConnection[]; error?: string };
    if (!response.ok) throw new Error(messageFrom(payload, "AI provider connections could not be loaded."));
    setProviderConnections(Array.isArray(payload.connections) ? payload.connections : []);
  }

  async function refreshResumeProfile(): Promise<void> {
    const response = await fetch("/api/account/profile", { cache: "no-store", credentials: "same-origin" });
    if (response.status === 404) {
      setResumeProfile(null);
      return;
    }
    const payload = await response.json() as { profile?: ResumeProfileView; error?: string };
    if (!response.ok || !payload.profile) throw new Error(messageFrom(payload, "Your resume profile could not be loaded."));
    setResumeProfile(payload.profile);
  }

  async function saveResumeProfile(skills: Array<{ canonical: string; confirmed: boolean }>): Promise<void> {
    setProfileSaving(true);
    setAccountError("");
    try {
      const response = await fetch("/api/account/profile", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skills }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(messageFrom(payload, "Your resume profile could not be saved."));
      await refreshResumeProfile();
      setAccountNotice("Your resume skill confirmations were saved to your private profile.");
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "Your resume profile could not be saved.");
      throw error;
    } finally {
      setProfileSaving(false);
    }
  }

  async function refreshPlatformAccess(): Promise<void> {
    const response = await fetch("/api/account/platform-ai-access", { cache: "no-store", credentials: "same-origin" });
    const payload = await response.json() as { enabled?: boolean; redeemed?: boolean; runsGranted?: number; runsRemaining?: number; model?: string; error?: string };
    if (!response.ok) throw new Error(messageFrom(payload, "TailorResume AI access could not be loaded."));
    setPlatformAccess({
      enabled: payload.enabled === true,
      redeemed: payload.redeemed === true,
      runsGranted: Number(payload.runsGranted ?? 0),
      runsRemaining: Number(payload.runsRemaining ?? 0),
      ...(typeof payload.model === "string" ? { model: payload.model } : {}),
    });
  }

  useEffect(() => {
    const onPopState = () => setRoute(routeFromLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (route.page === "results") return;
    let active = true;
    Promise.all([
      fetch("/api/account", { cache: "no-store", credentials: "same-origin" }).then(async (response) => {
        const payload = await response.json() as HostedAccountResponse & { error?: string };
        if (!response.ok) throw new Error(messageFrom(payload, "Your cloud account data could not be loaded."));
        if (!active) return;
        setAccount(payload);
      }),
      fetch("/api/account/providers", { cache: "no-store", credentials: "same-origin" }).then(async (response) => {
        const payload = await response.json() as { connections?: HostedProviderConnection[]; error?: string };
        if (!response.ok) throw new Error(messageFrom(payload, "AI provider connections could not be loaded."));
        if (active) setProviderConnections(Array.isArray(payload.connections) ? payload.connections : []);
      }),
      refreshResumeProfile(),
    ])
      .catch((error: unknown) => {
        if (active) setAccountError(error instanceof Error ? error.message : "Your cloud account data could not be loaded.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [route.page]);

  useEffect(() => {
    void refreshPlatformAccess().catch((error: unknown) => {
      setAccountError(error instanceof Error ? error.message : "TailorResume AI access could not be loaded.");
    });
  }, []);

  useEffect(() => {
    if (route.page !== "results" || !route.runId) return;
    let active = true;
    void fetch(`/api/account/runs/${encodeURIComponent(route.runId)}`, { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => {
        const payload = await response.json() as { run?: HostedTailoringRunState; error?: string };
        if (!response.ok || !payload.run) throw new Error(messageFrom(payload, "This tailoring result could not be loaded."));
        if (active) setHostedRun(payload.run);
      })
      .catch((error: unknown) => {
        if (active) setAccountError(error instanceof Error ? error.message : "This tailoring result could not be loaded.");
      });
    return () => { active = false; };
  }, [route.page, route.runId]);

  useEffect(() => {
    if (hostedRun?.status === "succeeded" && route.page !== "results" && hostedRun.runId === autoOpenResultRunId.current) {
      autoOpenResultRunId.current = null;
      navigateTo(`/results/${encodeURIComponent(hostedRun.runId)}`);
    }
  }, [hostedRun?.status, hostedRun?.runId, route.page]);

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
    if (route.page !== "workspace") return;
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
  }, [route.page]);

  async function saveProvider(provider: HostedProvider, event: FormEvent<HTMLFormElement>): Promise<void> {
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
      setAccountNotice(`${providerLabel(provider)} key verified and saved encrypted to your account.`);
      navigateTo("/");
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "The provider key could not be saved.");
    } finally {
      setSavingProvider(null);
    }
  }

  async function loadProviderModels(provider: HostedProvider): Promise<void> {
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

  async function saveProviderModel(provider: HostedProvider): Promise<void> {
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
      setAccountNotice(`${providerLabel(provider)} model selection saved.`);
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "The model selection could not be saved.");
    } finally {
      setSavingModel(null);
    }
  }

  async function removeProvider(provider: HostedProvider): Promise<void> {
    if (!window.confirm(`Remove the saved ${providerLabel(provider)} API key?`)) return;
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

  async function redeemPlatformInvite(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setAccountError("");
    setAccountNotice("");
    setRedeemingInvite(true);
    try {
      const response = await fetch("/api/account/platform-ai-access/redeem", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: inviteCode }),
      });
      const payload = await response.json() as { access?: { enabled?: boolean; redeemed?: boolean; runsGranted?: number; runsRemaining?: number; model?: string }; error?: string };
      if (!response.ok || !payload.access) throw new Error(messageFrom(payload, "The AI access code could not be activated."));
      setPlatformAccess({
        enabled: payload.access.enabled === true,
        redeemed: payload.access.redeemed === true,
        runsGranted: Number(payload.access.runsGranted ?? 0),
        runsRemaining: Number(payload.access.runsRemaining ?? 0),
        ...(typeof payload.access.model === "string" ? { model: payload.access.model } : {}),
      });
      setAiSource("platform");
      setAiConsent(false);
      setInviteCode("");
      setAccountNotice(`TailorResume AI is active. ${payload.access.runsRemaining ?? 0} of ${payload.access.runsGranted ?? 0} runs remain.`);
      navigateTo("/");
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "The AI access code could not be activated.");
    } finally {
      setRedeemingInvite(false);
    }
  }

  async function submitHostedRun(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setAccountError("");
    setAccountNotice("");
    const provider = providerConnections.find((item) => item.provider === activeTailoringProvider && item.selected_model);
    if (!currentResume) {
      setAccountError("Save a base resume before tailoring.");
      return;
    }
    if (aiSource === "user" && !provider) {
      setAccountError(`Connect ${providerLabel(activeTailoringProvider)} and select a model before tailoring.`);
      return;
    }
    if (aiSource === "platform" && (!platformAccess.enabled || !platformAccess.redeemed || platformAccess.runsRemaining <= 0)) {
      setAccountError("Activate an AI access code or connect your own provider key before starting a run.");
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
        body: JSON.stringify({ jobDescription: jobDescription.trim(), provider: activeTailoringProvider, aiSource, aiConsent: true }),
      });
      const payload = await response.json() as { run?: HostedTailoringRunState; error?: string };
      if (!response.ok || !payload.run) throw new Error(messageFrom(payload, "The tailoring run could not be started."));
      autoOpenResultRunId.current = payload.run.runId;
      setHostedRun(payload.run);
      if (aiSource === "platform") {
        setPlatformAccess((current) => ({ ...current, runsRemaining: Math.max(0, current.runsRemaining - 1) }));
      }
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
      if (route.page === "results") navigateTo("/");
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
      const payload = await response.json() as { error?: string; cleanupWarning?: boolean; detectedSkillCount?: number };
      if (!response.ok) throw new Error(messageFrom(payload, "The resume could not be uploaded."));
      await Promise.all([refreshAccount(), refreshResumeProfile()]);
      setAccountNotice(payload.cleanupWarning
        ? `The new base resume is saved and ${payload.detectedSkillCount ?? 0} recognized skills were added to your profile. An older resume copy could not be cleaned up yet.`
        : `Your base resume is saved securely. ${payload.detectedSkillCount ?? 0} recognized skills were added to your profile.`);
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
  const availableTailoringProviders = (["anthropic", "openai"] as const).filter((provider) =>
    providerConnections.some((connection) => connection.provider === provider && Boolean(connection.selected_model)));
  const activeTailoringProvider = aiSource === "platform" ? "openai" : availableTailoringProviders.includes(tailoringProvider)
    ? tailoringProvider
    : availableTailoringProviders[0] ?? tailoringProvider;
  useEffect(() => {
    if (availableTailoringProviders.length === 0 && platformAccess.redeemed && platformAccess.runsRemaining > 0) {
      setAiSource("platform");
    } else if (!platformAccess.redeemed && availableTailoringProviders.length > 0) {
      setAiSource("user");
    }
  }, [availableTailoringProviders.length, platformAccess.redeemed, platformAccess.runsRemaining]);
  const providerSettingsPanel = (
    <section className="hosted-card" aria-labelledby="providers-title">
      <div className="panel-heading">
        <div><span className="step-label">01 / PERSONAL PROVIDERS</span><h2 id="providers-title">Your provider keys</h2></div>
        <span className="field-meta">Bring your own API key</span>
      </div>
      <p className="hosted-help-copy">Your keys are encrypted by the server and never returned to the browser. Saving a key checks its model catalogue; it does not send your resume or job description. Provider usage is billed by that provider. <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">Manage OpenAI API keys</a>.</p>
      {(["anthropic", "xai", "openai"] as const).map((provider) => {
        const connection = providerConnections.find((item) => item.provider === provider);
        const connected = Boolean(connection);
        const label = providerLabel(provider);
        return (
          <form className="hosted-provider-row" key={provider} onSubmit={(event) => void saveProvider(provider, event)}>
            <div className="hosted-provider-heading">
              <div><strong>{label}</strong><span>{connection?.last_verified_at ? `Key verified ${new Date(connection.last_verified_at).toLocaleDateString()}` : connected ? "Key saved · not yet verified" : "No key saved"}</span></div>
              {connected && <button className="text-button hosted-remove-button" type="button" onClick={() => void removeProvider(provider)}>Remove key</button>}
            </div>
            <label className="visually-hidden" htmlFor={`${provider}-api-key`}>{label} API key</label>
            <input id={`${provider}-api-key`} className="hosted-provider-input" type="password" autoComplete="new-password" value={providerKeys[provider]} onChange={(event) => setProviderKeys((current) => ({ ...current, [provider]: event.target.value }))} placeholder={connected ? "Enter a replacement key" : "Paste your API key"} minLength={20} maxLength={500} />
            <div className="hosted-provider-footer">
              <span className="field-meta">Usage is billed by {provider === "anthropic" ? "Anthropic" : provider === "xai" ? "xAI" : "OpenAI Platform"}.</span>
              <button className="secondary-button" type="submit" disabled={savingProvider !== null || providerKeys[provider].length < 20}>{savingProvider === provider ? "Verifying…" : connected ? "Replace key" : "Verify key"}</button>
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
  );
  const hostedHeader = (
    <header className="topbar">
      <a className="brand" href="/" onClick={(event) => { event.preventDefault(); navigateTo("/"); }} aria-label="TailorResume home">
        <span className="brand-mark" aria-hidden="true">T</span>
        <span>tailor<span className="brand-light">resume</span></span>
      </a>
      <div className="topbar-actions">
        {route.page === "workspace"
          ? <button className="secondary-button" type="button" onClick={() => navigateTo("/settings/ai")}>AI settings</button>
          : <button className="secondary-button" type="button" onClick={() => navigateTo("/")}>Back to workspace</button>}
        <button className="theme-toggle" type="button" onClick={onCycleTheme} aria-label={`Theme setting: ${themeMode}. Activate to change theme`} title="Cycles between system, light, and dark themes">
          <span aria-hidden="true">{themeMode === "dark" ? "☾" : themeMode === "light" ? "☀" : "◐"}</span>
          <span>{themeMode === "system" ? "System" : themeMode === "light" ? "Light" : "Dark"}</span>
        </button>
        <button className="secondary-button" type="button" onClick={onSignOut} disabled={authBusy}>{authBusy ? "Signing out…" : "Sign out"}</button>
      </div>
    </header>
  );

  if (route.page === "settings") {
    return (
      <div className="app-shell">
        {hostedHeader}
        <main id="top" className="main-content hosted-main settings-main">
          <section className="intro" aria-labelledby="settings-title">
            <p className="eyebrow">ACCOUNT SETTINGS <span>·</span> AI PROVIDERS</p>
            <h1 id="settings-title">AI access and models.</h1>
            <p className="intro-copy">Manage your provider keys and models here. Enter an AI access code from the main workspace.</p>
          </section>
          {accountError && <div className="error-message hosted-feedback" role="alert"><span aria-hidden="true">!</span>{accountError}</div>}
          {accountNotice && <div className="account-notice hosted-feedback" role="status">{accountNotice}</div>}
          <section className="hosted-card platform-ai-card" aria-labelledby="platform-ai-title">
            <div className="panel-heading">
              <div><span className="step-label">INVITATION ACCESS</span><h2 id="platform-ai-title">TailorResume AI</h2></div>
              {platformAccess.redeemed && <span className="status-pill">{platformAccess.runsRemaining} runs left</span>}
            </div>
          {!platformAccess.enabled
              ? <p className="hosted-help-copy">Shared AI access is not available yet. You can still connect your own provider key below.</p>
              : platformAccess.redeemed
                ? <p className="hosted-help-copy">Your invitation is active. {platformAccess.runsRemaining} of {platformAccess.runsGranted} included runs remain. {platformAccess.runsRemaining === 0 ? "Connect your own provider key to keep tailoring resumes." : "No personal AI API key is needed."}</p>
                : <>
                  <p className="hosted-help-copy">Invitation access can be activated from the AI access section on your main workspace.</p>
                  <button className="secondary-button" type="button" onClick={() => navigateTo("/")}>Go to workspace</button>
                </>}
          </section>
          {providerSettingsPanel}
        </main>
        <footer className="page-footer"><span>TAILORRESUME</span><span>AI provider settings</span></footer>
      </div>
    );
  }

  if (route.page === "results") {
    const run = hostedRun?.runId === route.runId ? hostedRun : null;
    return (
      <div className="app-shell">
        {hostedHeader}
        <main className="main-content hosted-main hosted-results-main">
          <section className="results-heading" aria-labelledby="hosted-results-title">
            <div>
              <p className="eyebrow">{run?.status === "succeeded" ? "TAILORING COMPLETE" : "TAILORING RUN"} <span>·</span> {run?.result?.originalFileName ?? "YOUR RESUME"}</p>
              <h1 id="hosted-results-title">Review your tailored resume.</h1>
              <p className="intro-copy">Check the highlighted edits, then download the DOCX when it looks right.</p>
            </div>
          </section>
          {accountError && <div className="error-message hosted-feedback" role="alert"><span aria-hidden="true">!</span>{accountError}</div>}
          {!run && !accountError && <section className="hosted-card result-loading" role="status">Loading this tailoring run…</section>}
          {!run && accountError && <section className="hosted-card" role="alert"><h2>Result unavailable.</h2><p className="intro-copy">Check that you are signed in to the account that created this run, or return to your workspace.</p><button className="primary-button" type="button" onClick={() => navigateTo("/")}>Back to workspace</button></section>}
          {run && ["queued", "running"].includes(run.status) && <section className="hosted-card result-loading" role="status">{run.status === "queued" ? "Your resume is queued…" : "Your resume is being prepared…"}</section>}
          {run && ["failed", "canceled", "expired"].includes(run.status) && <section className="hosted-card" role="alert"><h2>Tailoring did not finish.</h2><p className="intro-copy">{run.error || "Return to the workspace and try again."}</p><button className="primary-button" type="button" onClick={() => navigateTo("/")}>Back to workspace</button></section>}
          {run?.result && <>
            <div className="results-actions"><button className="text-button hosted-remove-button" type="button" onClick={() => void deleteHostedRun()}>Delete this run</button></div>
            <section className="hosted-card hosted-run-result" aria-label="Tailoring result">
              <ReviewPanel result={run.result} retentionCopy="This hosted result and generated file expire after 30 days. You can delete them sooner." />
            </section>
          </>}
        </main>
        <footer className="page-footer"><span>TAILORRESUME</span><span>Private hosted workspace</span></footer>
      </div>
    );
  }

  return (
    <div className="app-shell">
      {hostedHeader}

      <main id="top" className="main-content hosted-main">
        <TailoringWorkspace
          eyebrow="RESUME WORKSPACE · HOSTED ACCOUNT"
          title="Your private resume workspace."
          description={`Signed in as ${user.displayName || user.email || "your Google account"}. Keep a base resume profile, then review how each job requirement maps to your evidence and proposed changes.`}
          notice={accountNotice && <div className="account-notice hosted-feedback" role="status">{accountNotice}</div>}
          error={accountError}
          resumeContent={(
            <>
              <span className="field-meta">DOCX · up to 15 MB</span>
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
              <p className="hosted-help-copy">TailorResume detects candidate skills and shows experience lines from your resume. Confirm only the skills that accurately describe your experience.</p>
            </>
          )}
          profileContent={<ResumeProfilePanel profile={resumeProfile} loading={loading && Boolean(currentResume)} saving={profileSaving} error="" onSave={saveResumeProfile} />}
          catalogReviewContent={<SkillCatalogReview />}
          aiAccessContent={(
            <>
              <div className="ai-access-intro">
                <p>Choose who provides AI for this run. Each option shows how usage is billed.</p>
                <button className="text-button" type="button" onClick={() => navigateTo("/settings/ai")}>Manage AI access</button>
              </div>
              <fieldset className="ai-access-options">
                <legend className="visually-hidden">Choose AI access and billing</legend>
                {availableTailoringProviders.length > 0 ? <label className={`ai-access-option${aiSource === "user" ? " is-selected" : ""}`}>
                  <span className="ai-access-option-title">
                    <input type="radio" name="ai-source" checked={aiSource === "user"} onChange={() => { setAiSource("user"); setAiConsent(false); }} />
                    <strong>My API key</strong>
                    <span className="ai-access-status is-connected">Connected</span>
                  </span>
                  <span className="ai-access-option-description">Usage is billed by {providerLabel(activeTailoringProvider)} under your provider account.</span>
                  {aiSource === "user" && <span className="ai-access-option-detail">{providerLabel(activeTailoringProvider)} · {providerConnections.find((item) => item.provider === activeTailoringProvider)?.selected_model ?? "model not selected"}</span>}
                </label> : <div className="ai-access-option is-unavailable">
                  <span className="ai-access-option-title"><strong>My API key</strong><span className="ai-access-status">Not connected</span></span>
                  <span className="ai-access-option-description">Connect a provider key in AI settings. Usage is billed by that provider.</span>
                  <button className="text-button" type="button" onClick={() => navigateTo("/settings/ai")}>Connect a key</button>
                </div>}
                {platformAccess.redeemed && platformAccess.runsRemaining > 0 ? <label className={`ai-access-option${aiSource === "platform" ? " is-selected" : ""}`}>
                  <span className="ai-access-option-title">
                    <input type="radio" name="ai-source" checked={aiSource === "platform"} onChange={() => { setAiSource("platform"); setAiConsent(false); }} />
                    <strong>Included TailorResume AI</strong>
                    <span className="ai-access-status is-connected">{platformAccess.runsRemaining} runs left</span>
                  </span>
                  <span className="ai-access-option-description">No personal API key needed. {platformAccess.runsRemaining} of {platformAccess.runsGranted} included runs remain.</span>
                  {aiSource === "platform" && <span className="ai-access-option-detail">OpenAI · {platformAccess.model ?? "shared model"}</span>}
                </label> : platformAccess.redeemed ? <div className="ai-access-option is-unavailable">
                  <span className="ai-access-option-title"><strong>Included TailorResume AI</strong><span className="ai-access-status">No runs left</span></span>
                  <span className="ai-access-option-description">Connect your own provider key to continue tailoring resumes.</span>
                </div> : platformAccess.enabled ? <div className="ai-access-option is-unavailable">
                  <span className="ai-access-option-title"><strong>Included TailorResume AI</strong><span className="ai-access-status">Invitation required</span></span>
                  <span className="ai-access-option-description">Enter your invitation code to activate included runs. Each account receives up to {platformAccess.runsGranted || 3} runs.</span>
                  <form className="ai-access-invite-form" onSubmit={(event) => void redeemPlatformInvite(event)}>
                    <label htmlFor="workspace-platform-ai-invite">AI access code</label>
                    <div className="invite-code-controls">
                      <input id="workspace-platform-ai-invite" className="hosted-provider-input" type="password" autoComplete="off" maxLength={200} value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} required />
                      <button className="primary-button" type="submit" disabled={redeemingInvite || !inviteCode.trim()}>{redeemingInvite ? "Checking…" : "Activate"}</button>
                    </div>
                  </form>
                </div> : null}
                {availableTailoringProviders.length === 0 && !platformAccess.enabled && !platformAccess.redeemed && <div className="ai-access-option is-unavailable">
                  <span className="ai-access-option-title"><strong>AI access is not set up</strong><span className="ai-access-status">Action needed</span></span>
                  <span className="ai-access-option-description">Connect your own provider key in AI settings to start tailoring.</span>
                  <button className="text-button" type="button" onClick={() => navigateTo("/settings/ai")}>Set up AI access</button>
                </div>}
              </fieldset>
              {aiSource === "user" && availableTailoringProviders.length > 0 && <label className="workspace-provider-picker" htmlFor="hosted-ai-provider">
                <span>AI provider</span>
                <select id="hosted-ai-provider" className="hosted-provider-input" value={activeTailoringProvider} onChange={(event) => { setTailoringProvider(event.target.value as HostedTailoringProvider); setAiConsent(false); }}>
                  {availableTailoringProviders.map((provider) => <option key={provider} value={provider}>{providerLabel(provider)}</option>)}
                </select>
              </label>}
            </>
          )}
          jobDescription={jobDescription}
          onJobDescriptionChange={setJobDescription}
          onSubmit={(event) => void submitHostedRun(event)}
          submitDisabled={!currentResume || (aiSource === "platform" ? platformAccess.runsRemaining < 1 : !providerConnections.some((item) => item.provider === activeTailoringProvider && item.selected_model)) || !aiConsent}
          inputDisabled={loading || !currentResume}
          submitting={tailoring}
          submitLabel="Tailor resume"
          submittingLabel="Starting…"
          jobDescriptionHint="Provider and model are configured above."
          consent={(
            <label className="hosted-consent-row">
              <input type="checkbox" checked={aiConsent} onChange={(event) => setAiConsent(event.target.checked)} />
              <span>I agree to send the job description and relevant resume experience bullets to {aiSource === "platform" ? `OpenAI through TailorResume (${platformAccess.model ?? "shared model"})` : providerLabel(activeTailoringProvider)} for this run.</span>
            </label>
          )}
          footerNote={(
            <div className="workspace-hosted-disclosure">
              Every run uses AI. The full job description and up to 12 relevant experience bullets are sent to the selected provider. TailorResume records requirement evidence and checks proposed changes, but cannot guarantee complete coverage or predict ATS ranking. Your DOCX and personal profile stay in your account; runs and generated files are stored for up to 30 days. Shared vocabulary is separate from your experience profile.
            </div>
          )}
        />
        {hostedRun && <div className="hosted-run-status" role="status" aria-live="polite">
          <div><strong>{hostedRun.status === "queued" ? "Queued" : hostedRun.status === "running" ? "Preparing your resume…" : hostedRun.status === "succeeded" ? "Resume ready" : hostedRun.status === "failed" ? "Run failed" : hostedRun.status}</strong><span>{new Date(hostedRun.createdAt).toLocaleString()} · {hostedRun.provider === "anthropic" ? "Claude" : hostedRun.provider === "openai" ? "OpenAI API" : hostedRun.provider ?? "AI provider"}{hostedRun.model ? ` · ${hostedRun.model}` : ""}</span></div>
          {hostedRun.status === "succeeded" && <button className="secondary-button" type="button" onClick={() => navigateTo(`/results/${encodeURIComponent(hostedRun.runId)}`)}>View result</button>}
          {(hostedRun.status === "failed" || hostedRun.status === "canceled") && hostedRun.error && <p>{hostedRun.error}</p>}
          {!(["queued", "running"].includes(hostedRun.status)) && <button className="text-button hosted-remove-button" type="button" onClick={() => void deleteHostedRun()}>Delete this run</button>}
        </div>}
        <div className="account-notice hosted-rollout-notice" role="status">
          Your resumes, profile, provider settings, and tailoring runs belong to this account. Hosted tailoring supports Claude and OpenAI. Grok key storage is available, but Grok tailoring is not enabled yet.
        </div>
      </main>
      <footer className="page-footer"><span>TAILORRESUME</span><span>Private hosted workspace</span></footer>
    </div>
  );
}
