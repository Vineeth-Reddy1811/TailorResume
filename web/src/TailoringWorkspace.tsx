import type { FormEvent, ReactNode } from "react";

export interface TailoringWorkspaceProps {
  eyebrow: string;
  title: string;
  description: string;
  resumeContent: ReactNode;
  profileContent?: ReactNode;
  catalogReviewContent?: ReactNode;
  aiAccessContent: ReactNode;
  jobDescription: string;
  onJobDescriptionChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  submitDisabled: boolean;
  inputDisabled?: boolean;
  submitting: boolean;
  submitLabel: string;
  submittingLabel: string;
  jobDescriptionHint: string;
  consent?: ReactNode;
  notice?: ReactNode;
  error?: string;
  footerNote?: ReactNode;
}

function StepCard({
  number,
  label,
  title,
  children,
}: {
  number: string;
  label: string;
  title: string;
  children: ReactNode;
}) {
  const headingId = `workspace-step-${number}`;
  return (
    <section className="workspace-step-card" aria-labelledby={headingId}>
      <div className="panel-heading">
        <div>
          <span className="step-label">{number} / {label}</span>
          <h2 id={headingId}>{title}</h2>
        </div>
      </div>
      {children}
    </section>
  );
}

export default function TailoringWorkspace({
  eyebrow,
  title,
  description,
  resumeContent,
  profileContent,
  catalogReviewContent,
  aiAccessContent,
  jobDescription,
  onJobDescriptionChange,
  onSubmit,
  submitDisabled,
  inputDisabled = false,
  submitting,
  submitLabel,
  submittingLabel,
  jobDescriptionHint,
  consent,
  notice,
  error,
  footerNote,
}: TailoringWorkspaceProps) {
  return (
    <>
      <section className="intro" aria-labelledby="workspace-title">
        <p className="eyebrow">{eyebrow}</p>
        <h1 id="workspace-title">{title}</h1>
        <p className="intro-copy">{description}</p>
      </section>

      {notice}
      {error && <div className="error-message hosted-feedback" role="alert"><span aria-hidden="true">!</span>{error}</div>}

      <StepCard number="01" label="BASE RESUME" title="Your resume">
        {resumeContent}
        {profileContent}
      </StepCard>

      <StepCard number="02" label="AI ACCESS" title="Choose how to use AI">
        {aiAccessContent}
      </StepCard>

      <form className="workspace-step-card workspace-tailoring-form" onSubmit={onSubmit}>
        <div className="panel-heading">
          <div>
            <span className="step-label">03 / TAILOR A RESUME</span>
            <h2>Match your resume to a job</h2>
          </div>
        </div>
        <label htmlFor="workspace-job-description">Job description</label>
        <textarea
          id="workspace-job-description"
          className="workspace-job-description"
          value={jobDescription}
          maxLength={30_000}
          disabled={inputDisabled || submitting}
          onChange={(event) => onJobDescriptionChange(event.currentTarget.value)}
          placeholder="Paste the full job description"
          aria-describedby="workspace-job-description-hint workspace-job-description-count"
          required
        />
        <div className="textarea-footer">
          <span id="workspace-job-description-hint">{jobDescriptionHint}</span>
          <span id="workspace-job-description-count" aria-live="polite">{jobDescription.length.toLocaleString()} / 30,000 characters</span>
        </div>
        {consent}
        <div className="workspace-submit-row">
          {footerNote && <div className="workspace-footer-note">{footerNote}</div>}
          <button className="primary-button" type="submit" disabled={submitDisabled || submitting || !jobDescription.trim()}>
            {submitting ? <><span className="button-spinner" aria-hidden="true" />{submittingLabel}</> : <>{submitLabel} <span aria-hidden="true">↗</span></>}
          </button>
        </div>
      </form>
      {catalogReviewContent}
    </>
  );
}
