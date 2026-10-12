import { useMemo, useRef, useState } from "react";
import type { TailoringChange, TailoringRunResponse } from "../../shared/api";

type ChangeFilter = "all" | "experience" | "skills";
type SummaryDetail = "requirements" | "evidence" | "documents";

function changeCategory(change: TailoringChange): "experience" | "skills" {
  return change.matchType === "technical-skills-section-update" ? "skills" : "experience";
}

function changeLabel(change: TailoringChange): string {
  if (change.matchType === "technical-skills-section-update") return "SKILLS SECTION";
  return change.action === "rewrite" ? "UPDATED EXPERIENCE" : "NEW EXPERIENCE";
}

function ChangeCard({ change, reasons }: { change: TailoringChange; reasons: string[] }) {
  const displayReason = reasons.find((reason) => !/^Add this JD-aligned skill\b/i.test(reason));
  return (
    <details className="change-card">
      <summary className="change-card-summary">
        <span className={`change-type ${changeCategory(change)}`}>{changeLabel(change)}</span>
        <span className="change-location">{change.section}{change.role ? ` · ${change.role}` : ""}</span>
        <span className="change-summary-preview">{change.proposedText}</span>
        <span className="change-disclosure-icon" aria-hidden="true" />
      </summary>
      <div className="change-card-details">
        {change.originalText && (
          <div className="diff-line removed"><span aria-hidden="true">−</span><p>{change.originalText}</p></div>
        )}
        <div className="diff-line added"><span aria-hidden="true">+</span><p>{change.proposedText}</p></div>
        {change.supportingQuote && (
          <div className="source-excerpt">
            <span>Source excerpt</span>
            <blockquote>{change.supportingQuote}</blockquote>
          </div>
        )}
        {change.requirements.length > 0 && (
          <div className="requirement-tags" aria-label="Related job requirements">
            {change.requirements.map((requirement) => <span key={requirement}>{requirement}</span>)}
          </div>
        )}
        {displayReason && <p className="change-reason">{displayReason}</p>}
      </div>
    </details>
  );
}

export default function ReviewPanel({ result, retentionCopy = "Temporary results are removed after one hour or when the local server stops." }: { result: TailoringRunResponse; retentionCopy?: string }) {
  const [filter, setFilter] = useState<ChangeFilter>("all");
  const [summaryDetail, setSummaryDetail] = useState<SummaryDetail | null>(null);
  const summaryButtonRefs = useRef<Record<SummaryDetail, HTMLButtonElement | null>>({ requirements: null, evidence: null, documents: null });
  const requirementReasons = useMemo(
    () => new Map(result.requirements.map((item) => [item.canonical, item.reason])),
    [result.requirements],
  );
  const visibleChanges = result.changes.filter((change) => filter === "all" || changeCategory(change) === filter);
  const evidenceCount = result.counts.experienceEvidence + result.counts.userConfirmedEvidence;
  const unresolvedRequirements = result.requirements.filter((item) => item.action === "unsupported");
  const evidenceRequirements = result.auditRequirements.filter((item) => item.status === "experience evidence" || item.status === "user-confirmed evidence");
  const summaryDetails: Record<SummaryDetail, { title: string; eyebrow: string }> = {
    requirements: { title: "Recognized job requirements", eyebrow: "01 / JD REQUIREMENTS" },
    evidence: { title: "Evidence in the tailored resume", eyebrow: "02 / TAILORED RESUME EVIDENCE" },
    documents: { title: "Document check details", eyebrow: "03 / DOCUMENT CHECKS" },
  };

  function toggleSummaryDetail(detail: SummaryDetail) {
    setSummaryDetail((current) => current === detail ? null : detail);
  }

  function closeSummaryDetail() {
    if (!summaryDetail) return;
    summaryButtonRefs.current[summaryDetail]?.focus();
    setSummaryDetail(null);
  }

  return (
    <>
      <div className="summary-grid" aria-label="Tailoring summary">
        <button ref={(element) => { summaryButtonRefs.current.requirements = element; }} type="button" className="summary-card summary-button" aria-expanded={summaryDetail === "requirements"} aria-controls={summaryDetail === "requirements" ? "summary-detail" : undefined} onClick={() => toggleSummaryDetail("requirements")}><span>JD requirements</span><strong>{result.counts.requirements}</strong><small>recognized · view details</small></button>
        <button ref={(element) => { summaryButtonRefs.current.evidence = element; }} type="button" className="summary-card summary-button" aria-expanded={summaryDetail === "evidence"} aria-controls={summaryDetail === "evidence" ? "summary-detail" : undefined} onClick={() => toggleSummaryDetail("evidence")}><span>Evidence in tailored resume</span><strong>{evidenceCount}</strong><small>supported requirements · view details</small></button>
        <div className="summary-card"><span>New additions</span><strong>{result.counts.additions}</strong><small>recorded changes</small></div>
        <button ref={(element) => { summaryButtonRefs.current.documents = element; }} type="button" className={`summary-card summary-button${result.counts.documentIssues ? " summary-warning" : ""}`} aria-expanded={summaryDetail === "documents"} aria-controls={summaryDetail === "documents" ? "summary-detail" : undefined} onClick={() => toggleSummaryDetail("documents")}><span>Document checks</span><strong>{result.counts.documentIssues}</strong><small>{result.counts.documentIssues ? "needs review · view details" : "no issues found · view details"}</small></button>
      </div>

      {summaryDetail && (
        <section id="summary-detail" className="summary-details" aria-live="polite" aria-labelledby="summary-detail-heading">
          <div className="summary-details-heading">
            <div><p className="step-label">{summaryDetails[summaryDetail].eyebrow}</p><h2 id="summary-detail-heading">{summaryDetails[summaryDetail].title}</h2></div>
            <button className="summary-detail-close" type="button" onClick={closeSummaryDetail} aria-label="Close summary details">×</button>
          </div>

          {summaryDetail === "requirements" && (
            result.requirements.length ? <div className="summary-detail-list">
              {result.requirements.map((item) => {
                const audit = result.auditRequirements.find((candidate) => candidate.requirement === item.canonical);
                return <article className="summary-detail-item" key={item.canonical}>
                  <strong className="summary-detail-name">{item.canonical}</strong>
                  {item.jobDescriptionEvidence?.length ? <ul className="summary-evidence-lines">{item.jobDescriptionEvidence.map((text, index) => <li key={`jd-${index}`}><span>JOB DESCRIPTION</span><blockquote>{text}</blockquote></li>)}</ul> : null}
                  {audit?.sourceEvidence.length ? <ul className="summary-evidence-lines">{audit.sourceEvidence.map((evidence) => <li key={evidence.paragraphId}><span>{evidence.section}</span><blockquote>{evidence.text}</blockquote></li>)}</ul> : <p className="summary-detail-empty-line">No matching line found in the original resume.</p>}
                </article>;
              })}
            </div> : <p className="summary-detail-empty">No job requirements were recognized.</p>
          )}

          {summaryDetail === "evidence" && (
            evidenceRequirements.length ? <div className="summary-detail-list">
              {evidenceRequirements.map((item) => <article className="summary-detail-item" key={item.requirement}>
                <strong className="summary-detail-name">{item.requirement}</strong>
                <ul className="summary-evidence-lines">{item.evidence.map((evidence) => <li key={evidence.paragraphId}><span>{evidence.section}</span><blockquote>{evidence.text}</blockquote></li>)}</ul>
              </article>)}
            </div> : <p className="summary-detail-empty">No evidence was recorded for this run.</p>
          )}

          {summaryDetail === "documents" && (
            <div className="summary-check-list">
              {([ ["Preservation checks", result.documentChecks.preservationIssues], ["Format checks", result.documentChecks.formatIssues] ] as const).map(([label, issues]) => <article className="summary-detail-item" key={label}>
                <div className="summary-detail-meta"><strong>{label}</strong><span className={issues.length ? "audit-status audit-status-missing" : "audit-status"}>{issues.length ? `${issues.length} issue${issues.length === 1 ? "" : "s"}` : "passed"}</span></div>
                {issues.length ? <ul>{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul> : <p>No issues reported.</p>}
              </article>)}
            </div>
          )}
        </section>
      )}

      <section className="change-section" aria-labelledby="change-heading">
        <div className="section-heading">
          <div><p className="step-label">02 / CHANGE RECORD</p><h2 id="change-heading">What changed</h2></div>
          <span className="change-count">{result.changes.length} {result.changes.length === 1 ? "change" : "changes"}</span>
        </div>

        <div className="change-toolbar" role="group" aria-label="Filter changes">
          <div className="filter-tabs">
            {(["all", "experience", "skills"] as const).map((option) => (
              <button key={option} type="button" className={filter === option ? "filter-tab active" : "filter-tab"} aria-pressed={filter === option} onClick={() => setFilter(option)}>
                {option === "all" ? "All changes" : option === "skills" ? "Skills" : "Experience"}
              </button>
            ))}
          </div>
          <span className="change-legend"><span className="legend-added">+</span> Added <span className="legend-removed">−</span> Original wording</span>
        </div>

        {visibleChanges.length ? (
          <div className="change-list">
            {visibleChanges.map((change) => (
              <ChangeCard
                key={change.id}
                change={change}
                reasons={change.requirements.map((requirement) => requirementReasons.get(requirement) ?? "").filter(Boolean)}
              />
            ))}
          </div>
        ) : (
          <div className="empty-changes">{result.changes.length ? "No changes in this category." : "No changes were needed for this job description."}</div>
        )}
      </section>

      <section className="resume-preview-panel" aria-labelledby="resume-preview-heading">
        <div className="resume-preview-header">
          <div>
            <p className="step-label">03 / TAILORED DOCUMENT</p>
            <h2 id="resume-preview-heading">Resume preview</h2>
            <p>Review the tailored resume before downloading. Edited lines are highlighted.</p>
          </div>
          <span className="preview-legend"><span aria-hidden="true">✦</span> Edited line</span>
        </div>
        {result.preview.length ? (
          <article className="resume-document" aria-label="Tailored resume text preview">
            {result.preview.map((line, index) => line.kind === "section-heading" ? (
              <h3 className="resume-section-heading" key={`${line.section}-${index}`}>{line.text}</h3>
            ) : (
              <p
                className={`resume-line${line.kind === "bullet" ? " is-bullet" : ""}${line.changed ? " is-changed" : ""}`}
                key={`${line.section}-${index}-${line.text.slice(0, 24)}`}
              >
                <span className="resume-line-text">{line.text}</span>
              </p>
            ))}
          </article>
        ) : (
          <p className="resume-preview-empty" role="status">Text preview is unavailable for this DOCX. You can still download the tailored file.</p>
        )}
      </section>

      <div className="coverage-grid">
        <section className="coverage-panel" aria-labelledby="coverage-heading">
          <p className="step-label">04 / REQUIREMENT COVERAGE</p>
          <h2 id="coverage-heading">What the audit found</h2>
          <ul className="coverage-list">
            <li><span>Already in experience</span><strong>{result.counts.experienceEvidence}</strong></li>
            <li><span>User-confirmed evidence</span><strong>{result.counts.userConfirmedEvidence}</strong></li>
            <li><span>Partial evidence</span><strong>{result.counts.partialEvidence}</strong></li>
            <li><span>Unverified wording</span><strong>{result.counts.unverifiedEvidence}</strong></li>
            <li><span>No evidence found</span><strong>{result.counts.missingEvidence}</strong></li>
            <li><span>Not parsed by current rules</span><strong>{result.counts.unsupported}</strong></li>
          </ul>
          {result.unsupportedRequirements.length > 0 && (
            <details className="unsupported-details">
              <summary>See unresolved JD points</summary>
              <ul>{unresolvedRequirements.length > 0
                ? unresolvedRequirements.map((item) => <li key={item.requirementId}><strong>{item.canonical}</strong><p>{item.reason}</p></li>)
                : result.unsupportedRequirements.map((item) => <li key={item}>{item}</li>)}</ul>
            </details>
          )}
          <p className="coverage-note">Coverage is a local document check. It cannot predict an employer’s ATS ranking.</p>
        </section>

        <section className="download-panel" aria-labelledby="download-heading">
          <span className="download-mark" aria-hidden="true">↓</span>
          <p className="step-label">05 / YOUR FILES</p>
          <h2 id="download-heading">Ready when you are.</h2>
          <p>Download your tailored resume after reviewing the highlighted changes above.</p>
          <a className="primary-button download-button" href={result.downloads.resume} download>Download tailored resume <span aria-hidden="true">↓</span></a>
          <small className="expiry-note">{retentionCopy}</small>
        </section>
      </div>

      {result.warnings.length > 0 && (
        <section className="audit-warning" aria-labelledby="warning-heading">
          <h2 id="warning-heading">Review notes</h2>
          <ul>{result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        </section>
      )}
    </>
  );
}
