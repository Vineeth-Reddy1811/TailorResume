import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from "react";
import type { ApiError, TailoringRunResponse } from "../../shared/api";
import ReviewPanel from "./ReviewPanel";
import { clearLocalDraft, loadLocalDraft, localSessionRetentionMs, saveLocalDraft, subscribeToLocalDraftClear } from "./localSession";

const maxResumeSize = 15 * 1024 * 1024;
const maxJobDescriptionLength = 30_000;
const localSessionRetentionDays = localSessionRetentionMs / (24 * 60 * 60 * 1000);
type ThemeMode = "system" | "light" | "dark";

function savedTheme(): ThemeMode {
  try {
    const theme = window.localStorage.getItem("tailorresume-theme");
    return theme === "light" || theme === "dark" ? theme : "system";
  } catch {
    return "system";
  }
}

export default function App() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(savedTheme);
  const [resume, setResume] = useState<File | null>(null);
  const [jobDescription, setJobDescription] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [sessionWarning, setSessionWarning] = useState("");
  const [result, setResult] = useState<TailoringRunResponse | null>(null);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [draftStorageReady, setDraftStorageReady] = useState(false);
  const [draftSaveRetry, setDraftSaveRetry] = useState(0);
  const [draftStatus, setDraftStatus] = useState<"loading" | "saving" | "saved" | "empty" | "save-error" | "restore-error" | "conflict">("loading");
  const [chatGPTConnected, setChatGPTConnected] = useState(false);
  const [chatGPTAccount, setChatGPTAccount] = useState("");
  const [chatGPTBusy, setChatGPTBusy] = useState(false);
  const [chatGPTNotice, setChatGPTNotice] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const draftSaveTimer = useRef<number | null>(null);
  const draftSaveVersion = useRef(0);
  const hasDraft = useRef(false);
  const draftEdited = useRef(false);
  const pendingLocalSaves = useRef(0);
  const restoredDraft = useRef<{ resume: File | null; jobDescription: string } | null>(null);
  const currentDraft = useRef<{ resume: File | null; jobDescription: string }>({ resume: null, jobDescription: "" });

  useEffect(() => {
    const root = document.documentElement;
    const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const activeTheme = themeMode === "system" ? (systemTheme.matches ? "dark" : "light") : themeMode;
      root.setAttribute("data-theme", activeTheme);
      const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
      if (themeColor) themeColor.content = activeTheme === "dark" ? "#111713" : "#f5f5f1";
    };
    applyTheme();
    try {
      window.localStorage.setItem("tailorresume-theme", themeMode);
    } catch {
      // Theme selection still works for the current page when storage is unavailable.
    }
    if (themeMode === "system") {
      systemTheme.addEventListener("change", applyTheme);
      return () => systemTheme.removeEventListener("change", applyTheme);
    }
    return undefined;
  }, [themeMode]);

  useEffect(() => {
    let active = true;
    const version = draftSaveVersion.current;
    loadLocalDraft().then((draft) => {
      if (!active || version !== draftSaveVersion.current) return;
      restoredDraft.current = draft;
      currentDraft.current = draft;
      draftEdited.current = false;
      setResume(draft.resume);
      setJobDescription(draft.jobDescription);
      hasDraft.current = Boolean(draft.resume || draft.jobDescription);
      setDraftStorageReady(true);
      setDraftStatus(draft.resume || draft.jobDescription ? "saved" : "empty");
      setDraftLoaded(true);
    }).catch(() => {
      if (!active || version !== draftSaveVersion.current) return;
      setDraftStatus("restore-error");
      setDraftLoaded(true);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const message = new URLSearchParams(window.location.search).get("chatgpt");
    if (message === "connected") setChatGPTNotice("ChatGPT is connected and plan usage is enabled.");
    if (message === "permission") setChatGPTNotice("ChatGPT plan usage permission was not granted. Reconnect and allow plan usage to tailor resumes.");
    if (message === "failed") setChatGPTNotice("ChatGPT connection could not be completed. Please try again.");
    if (message) window.history.replaceState({}, "", `${window.location.pathname}${window.location.hash}`);
    void refreshChatGPTStatus();
  }, []);

  async function refreshChatGPTStatus() {
    try {
      const response = await fetch("/api/auth/chatgpt");
      const payload = await response.json() as { connected?: boolean; email?: string };
      setChatGPTConnected(response.ok && payload.connected === true);
      setChatGPTAccount(payload.email ?? "");
    } catch {
      setChatGPTConnected(false);
      setChatGPTAccount("");
    }
  }

  async function connectChatGPT() {
    setChatGPTBusy(true);
    setChatGPTNotice("");
    try {
      const response = await fetch("/api/auth/chatgpt/start", { method: "POST" });
      const payload = await response.json() as { authorizationUrl?: string; error?: string };
      if (!response.ok || !payload.authorizationUrl) throw new Error(payload.error || "Could not start ChatGPT sign-in.");
      window.location.assign(payload.authorizationUrl);
    } catch (requestError) {
      setChatGPTNotice(requestError instanceof Error ? requestError.message : "Could not start ChatGPT sign-in.");
      setChatGPTBusy(false);
    }
  }

  async function disconnectChatGPT() {
    setChatGPTBusy(true);
    try {
      const response = await fetch("/api/auth/chatgpt/disconnect", { method: "POST" });
      const payload = await response.json() as { revoked?: boolean; error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not disconnect ChatGPT.");
      setChatGPTConnected(false);
      setChatGPTAccount("");
      setChatGPTNotice(payload.revoked
        ? "ChatGPT was disconnected and its renewable session was revoked."
        : "ChatGPT was disconnected locally. OpenAI could not confirm remote revocation; you can also remove access in ChatGPT Settings.");
    } catch (requestError) {
      setChatGPTNotice(requestError instanceof Error ? requestError.message : "Could not disconnect ChatGPT.");
    } finally {
      setChatGPTBusy(false);
    }
  }

  useEffect(() => subscribeToLocalDraftClear(() => {
    if (draftSaveTimer.current !== null) window.clearTimeout(draftSaveTimer.current);
    draftSaveTimer.current = null;
    draftSaveVersion.current += 1;
    hasDraft.current = false;
    restoredDraft.current = { resume: null, jobDescription: "" };
    currentDraft.current = { resume: null, jobDescription: "" };
    draftEdited.current = false;
    setResume(null);
    setJobDescription("");
    setDraftLoaded(true);
    setDraftStorageReady(true);
    setDraftStatus("empty");
    setSessionWarning("");
    if (fileInput.current) fileInput.current.value = "";
  }), []);

  useEffect(() => {
    if (!draftLoaded || (!draftStorageReady && !resume && !jobDescription) || (!resume && !jobDescription && !hasDraft.current && !draftEdited.current && pendingLocalSaves.current === 0)) return;
    if (restoredDraft.current?.resume === resume && restoredDraft.current.jobDescription === jobDescription) return;
    let active = true;
    const version = ++draftSaveVersion.current;
    const timer = window.setTimeout(() => {
      draftSaveTimer.current = null;
      setDraftStatus("saving");
      pendingLocalSaves.current += 1;
      saveLocalDraft(resume, jobDescription).then(() => {
        restoredDraft.current = { resume, jobDescription };
        if (currentDraft.current.resume === resume && currentDraft.current.jobDescription === jobDescription) {
          draftEdited.current = false;
        } else {
          draftEdited.current = true;
          setDraftSaveRetry((retry) => retry + 1);
        }
        if (active && version === draftSaveVersion.current) {
          hasDraft.current = Boolean(resume || jobDescription);
          setDraftStorageReady(true);
          setDraftStatus(resume || jobDescription ? "saved" : "empty");
          setSessionWarning("");
        }
      }).catch((saveError: unknown) => {
        if (active && version === draftSaveVersion.current) {
          const message = saveError instanceof Error ? saveError.message : "";
          const conflict = message.includes("another tab");
          setDraftStatus(conflict ? "conflict" : "save-error");
          setSessionWarning(conflict
            ? "This run uses the inputs shown here, but another tab has a newer saved session. Reload to restore that session."
            : "This run uses the inputs shown here, but they could not be saved in this browser. Keep this page open or save the inputs elsewhere before reloading.");
        }
      }).finally(() => {
        pendingLocalSaves.current = Math.max(0, pendingLocalSaves.current - 1);
      });
    }, 350);
    draftSaveTimer.current = timer;
    return () => {
      active = false;
      window.clearTimeout(timer);
      if (draftSaveTimer.current === timer) draftSaveTimer.current = null;
      if (draftSaveVersion.current === version) draftSaveVersion.current += 1;
    };
  }, [draftLoaded, draftStorageReady, resume, jobDescription, draftSaveRetry]);

  function cycleTheme() {
    setThemeMode((current) => current === "system" ? "light" : current === "light" ? "dark" : "system");
  }

  function acceptResume(file: File | undefined) {
    if (!file || isSubmitting) return;
    if (!file.name.toLowerCase().endsWith(".docx")) {
      setError("Choose a Word document ending in .docx.");
      return;
    }
    if (file.size > maxResumeSize) {
      setError("The resume must be 15 MB or smaller.");
      return;
    }
    setError("");
    currentDraft.current = { resume: file, jobDescription };
    draftEdited.current = true;
    setResume(file);
  }

  function updateJobDescription(value: string) {
    currentDraft.current = { resume, jobDescription: value };
    draftEdited.current = true;
    setJobDescription(value);
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    acceptResume(event.currentTarget.files?.[0]);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    if (!draftLoaded || isSubmitting) return;
    acceptResume(event.dataTransfer.files[0]);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!resume) {
      setError("Choose your resume before continuing.");
      return;
    }
    if (!jobDescription.trim()) {
      setError("Paste the job description before continuing.");
      return;
    }

    const formData = new FormData();
    formData.append("resume", resume);
    formData.append("jobDescription", jobDescription);
    setIsSubmitting(true);
    setResult(null);
    try {
      try {
        const alreadySaved = restoredDraft.current?.resume === resume && restoredDraft.current.jobDescription === jobDescription;
        if (!alreadySaved || draftEdited.current || pendingLocalSaves.current > 0) {
          await saveLocalDraft(resume, jobDescription);
          restoredDraft.current = { resume, jobDescription };
          if (currentDraft.current.resume === resume && currentDraft.current.jobDescription === jobDescription) {
            draftEdited.current = false;
          } else {
            draftEdited.current = true;
            setDraftSaveRetry((retry) => retry + 1);
          }
          hasDraft.current = true;
          setDraftStorageReady(true);
          setDraftStatus("saved");
          setSessionWarning("");
        }
      } catch (saveError) {
        const message = saveError instanceof Error ? saveError.message : "";
        const conflict = message.includes("another tab");
        setDraftStatus(conflict ? "conflict" : "save-error");
        setSessionWarning(conflict
          ? "This run uses the inputs shown here, but another tab has a newer saved session. Reload to restore that session."
          : "This run uses the inputs shown here, but they could not be saved in this browser. Keep this page open or save the inputs elsewhere before reloading.");
      }
      const response = await fetch("/api/runs", { method: "POST", body: formData });
      const payload = await response.json() as TailoringRunResponse | ApiError;
      if (!response.ok) {
        throw new Error("error" in payload ? payload.error : "Resume processing failed. Please try again.");
      }
      setResult(payload as TailoringRunResponse);
      window.requestAnimationFrame(() => document.getElementById("results")?.focus());
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not reach the local app. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  function startNewRun() {
    setResult(null);
    setError("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function clearSession() {
    if (draftSaveTimer.current !== null) window.clearTimeout(draftSaveTimer.current);
    draftSaveTimer.current = null;
    draftSaveVersion.current += 1;
    try {
      await clearLocalDraft();
      hasDraft.current = false;
      restoredDraft.current = { resume: null, jobDescription: "" };
      currentDraft.current = { resume: null, jobDescription: "" };
      draftEdited.current = false;
      setResume(null);
      setJobDescription("");
      setError("");
      setSessionWarning("");
      setDraftStorageReady(true);
      setDraftStatus("empty");
      if (fileInput.current) fileInput.current.value = "";
    } catch {
      setDraftStatus("save-error");
    }
  }

  const draftStatusLabel = draftStatus === "loading" ? "Restoring saved session…"
    : draftStatus === "saving" ? "Saving on this browser…"
    : draftStatus === "saved" ? `Session saved · ${localSessionRetentionDays}-day retention`
    : draftStatus === "restore-error" ? "Could not restore saved session"
    : draftStatus === "conflict" ? "Draft changed in another tab · reload to restore it"
    : draftStatus === "save-error" ? "Could not save local session"
    : `Draft autosaves · ${localSessionRetentionDays}-day retention`;

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="TailorResume home">
          <span className="brand-mark" aria-hidden="true">T</span>
          <span>tailor<span className="brand-light">resume</span></span>
        </a>
        <div className="topbar-actions">
          <button className="theme-toggle" type="button" onClick={cycleTheme} aria-label={`Theme setting: ${themeMode}. Activate to change theme`} title="Cycles between system, light, and dark themes">
            <span aria-hidden="true">{themeMode === "dark" ? "☾" : themeMode === "light" ? "☀" : "◐"}</span>
            <span>{themeMode === "system" ? "System" : themeMode === "light" ? "Light" : "Dark"}</span>
          </button>
      <div className="privacy-badge"><span className="privacy-dot" />Local app · ChatGPT plan drafting</div>
        </div>
      </header>

      <main id="top" className="main-content">
        {!result ? (
          <>
            <section className="intro" aria-labelledby="page-title">
              <p className="eyebrow">RESUME WORKSPACE <span>·</span> OPENAI-ASSISTED</p>
              <h1 id="page-title">Make your experience<br className="desktop-break" /> speak to the role.</h1>
              <p className="intro-copy">Add a resume and job description. Review every suggested addition, then download your tailored copy.</p>
            </section>

            <section className="chatgpt-connection" aria-label="ChatGPT connection">
              <div className="chatgpt-connection-copy">
                <span className="step-label">AI CONNECTION</span>
                <strong>{chatGPTConnected ? "ChatGPT plan connected" : "Connect your ChatGPT plan"}</strong>
                <span>{chatGPTConnected ? (chatGPTAccount || "Plan usage is enabled for this local app.") : "Authorize ChatGPT plan usage. No API key or separate API billing setup is used."}</span>
              </div>
              <div className="chatgpt-connection-actions">
                {chatGPTConnected && <a className="text-button" href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">Manage usage</a>}
                {chatGPTConnected
                  ? <button className="secondary-button" type="button" disabled={chatGPTBusy} onClick={disconnectChatGPT}>Disconnect</button>
                  : <button className="primary-button" type="button" disabled={chatGPTBusy} onClick={connectChatGPT}>{chatGPTBusy ? "Connecting…" : "Continue with ChatGPT"}</button>}
              </div>
              {chatGPTNotice && <p className="chatgpt-notice" role="status">{chatGPTNotice}</p>}
            </section>

            <form className="input-panel" onSubmit={onSubmit}>
              <div className="panel-heading">
                <div>
                  <span className="step-label">01 / INPUT</span>
                  <h2>Start with the essentials</h2>
                </div>
                <div className="panel-status-group">
                  <span className={`local-note${draftStatus === "save-error" || draftStatus === "restore-error" ? " local-note-error" : draftStatus === "conflict" ? " local-note-conflict" : ""}`} aria-live="polite"><span aria-hidden="true">●</span>{draftStatusLabel}</span>
                  {draftLoaded && ((resume || jobDescription) || draftStatus === "restore-error") && <button className="text-button clear-session-button" type="button" onClick={clearSession}>Clear saved session</button>}
                </div>
              </div>

              <div className="form-grid">
                <section className="field-group" aria-labelledby="resume-label">
                  <div className="field-title-row">
                    <label id="resume-label" className="field-label" htmlFor="resume-file">Your resume</label>
                    <span className="field-meta">DOCX · up to 15 MB</span>
                  </div>
                  <div
                    className={`drop-zone${isDragging ? " is-dragging" : ""}${resume ? " has-file" : ""}`}
                    onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }}
                    onDragLeave={() => setIsDragging(false)}
                    onDrop={onDrop}
                  >
                    <input
                      ref={fileInput}
                      className="visually-hidden"
                      id="resume-file"
                      type="file"
                      disabled={!draftLoaded || isSubmitting}
                      accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                      onChange={onFileChange}
                    />
                    <div className="file-symbol" aria-hidden="true">DOC</div>
                    <div className="drop-copy">
                      {resume ? <><strong>{resume.name}</strong><span>{(resume.size / 1024).toFixed(0)} KB · ready to tailor</span></> : <><strong>Drop your resume here</strong><span>or <label className="browse-link" htmlFor="resume-file">browse files</label></span></>}
                    </div>
                    {resume && <button className="text-button remove-file" type="button" disabled={!draftLoaded || isSubmitting} onClick={() => { currentDraft.current = { resume: null, jobDescription }; draftEdited.current = true; setResume(null); if (fileInput.current) fileInput.current.value = ""; }}>Remove</button>}
                  </div>
                </section>

                <section className="field-group" aria-labelledby="jd-label">
                  <div className="field-title-row">
                    <label id="jd-label" className="field-label" htmlFor="job-description">Job description</label>
                    <span className="field-meta">Paste the full description</span>
                  </div>
                  <textarea
                    id="job-description"
                    className="jd-input"
                    disabled={!draftLoaded || isSubmitting}
                    value={jobDescription}
                    maxLength={maxJobDescriptionLength}
                    onChange={(event) => updateJobDescription(event.currentTarget.value)}
                    placeholder="Paste the job description here…"
                    rows={8}
                    required
                  />
                  <div className="textarea-footer"><span>Include the responsibilities and qualifications.</span><span>{jobDescription.length.toLocaleString()} / {maxJobDescriptionLength.toLocaleString()}</span></div>
                </section>
              </div>

              {error && <div className="error-message" role="alert"><span aria-hidden="true">!</span>{error}</div>}

              <div className="form-footer">
                <p>Your original resume is never changed. ChatGPT drafts missing experience points; the app applies the change plan locally.</p>
                <button className="primary-button" type="submit" disabled={!draftLoaded || !chatGPTConnected || isSubmitting || !resume || !jobDescription.trim()}>
                  {isSubmitting ? <><span className="button-spinner" aria-hidden="true" />Tailoring resume…</> : <>Tailor my resume <span aria-hidden="true">↗</span></>}
                </button>
              </div>
            </form>

            <div className="process-note"><span>AI AND YOUR DATA</span><p>Each run sends the full job description (up to 30,000 characters) and up to 12 relevant resume experience bullets to OpenAI in one ChatGPT plan request. ChatGPT identifies required technical skills and drafts missing experience points; the app checks each skill against job-description excerpts. The sign-in tokens stay on this computer and are never stored in browser storage. Newly found technical skills are saved to your local profile; broad competencies go under experience instead of Skills.</p></div>
          </>
        ) : (
          <section id="results" className="results-section" tabIndex={-1} aria-labelledby="results-title">
            <div className="results-heading">
              <div>
                <p className="eyebrow">TAILORING COMPLETE <span>·</span> {result.originalFileName}</p>
                <h1 id="results-title">Review your tailored draft.</h1>
                <p className="intro-copy">Every change is recorded below. Your source resume remains untouched.</p>
              </div>
              <button className="secondary-button" type="button" onClick={startNewRun}>Edit saved inputs</button>
            </div>
            {sessionWarning && <div className="error-message session-warning" role="status"><span aria-hidden="true">!</span>{sessionWarning}</div>}
            <ReviewPanel result={result} />
          </section>
        )}
      </main>

      <footer className="page-footer"><span>TAILORRESUME</span><span>Local app · OpenAI-assisted drafting · Your source resume stays unchanged</span></footer>
    </div>
  );
}
