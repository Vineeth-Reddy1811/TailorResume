export type RequirementAction = "keep" | "rewrite" | "add" | "unsupported";

export interface RequirementSummary {
  requirementId: string;
  canonical: string;
  priority: "required" | "preferred";
  action: RequirementAction;
  reason: string;
  changeId?: string;
  evidenceParagraphIds?: string[];
  jobDescriptionEvidence?: string[];
}

export interface TailoringChange {
  id: string;
  action: "rewrite" | "add";
  matchType: "similar-existing-line" | "new-experience-line" | "technical-skills-section-update";
  status: string;
  sourceParagraphId?: string;
  afterParagraphId?: string;
  section: string;
  role: string | null;
  originalText?: string;
  proposedText: string;
  supportingQuote?: string;
  requirements: string[];
  userConfirmed: boolean;
  source: string;
}

export interface AuditRequirement {
  requirement: string;
  priority: "required" | "preferred";
  status: string;
  exactJobTermInTailoredExperience: boolean;
  note: string;
  evidence: Array<{
    paragraphId: string;
    section: string;
    matchedTerms: string[];
    text: string;
  }>;
  sourceEvidence: Array<{
    paragraphId: string;
    section: string;
    matchedAliases: string[];
    text: string;
  }>;
}

export interface ResumePreviewLine {
  text: string;
  section: string;
  kind: "section-heading" | "bullet" | "paragraph";
  changed: boolean;
}

export interface TailoringRunResponse {
  runId: string;
  originalFileName: string;
  counts: {
    requirements: number;
    unchanged: number;
    additions: number;
    rewrites: number;
    unsupported: number;
    experienceEvidence: number;
    userConfirmedEvidence: number;
    partialEvidence: number;
    missingEvidence: number;
    unverifiedEvidence: number;
    documentIssues: number;
  };
  requirements: RequirementSummary[];
  unsupportedRequirements: string[];
  changes: TailoringChange[];
  auditRequirements: AuditRequirement[];
  documentChecks: {
    preservationIssues: string[];
    formatIssues: string[];
  };
  warnings: string[];
  preview: ResumePreviewLine[];
  downloads: {
    resume: string;
  };
}

export interface ApiError {
  error: string;
}

export interface AuthenticatedAppUser {
  id: string;
  email: string | null;
  displayName: string | null;
}

export interface AppSessionResponse {
  mode: "local" | "hosted";
  authenticated: boolean;
  user: AuthenticatedAppUser | null;
  error?: string;
}

export interface HostedResumeRecord {
  id: string;
  display_name: string;
  original_file_name: string;
  file_size_bytes: number | string;
  sha256: string;
  is_default: boolean;
  created_at: string;
}

export interface HostedAccountResponse {
  displayName: string | null;
  experienceProfile: Record<string, unknown>;
  experienceProfileUpdatedAt: string | null;
  resumes: HostedResumeRecord[];
}

export interface HostedProviderConnection {
  provider: "anthropic" | "xai";
  provider_account_label: string | null;
  connected_at: string;
  last_verified_at: string | null;
  selected_model: string | null;
}

export type HostedTailoringRunStatus = "queued" | "running" | "succeeded" | "failed" | "canceled" | "expired";

export interface HostedTailoringRunState {
  runId: string;
  status: HostedTailoringRunStatus;
  provider: string | null;
  model: string | null;
  createdAt: string;
  result: TailoringRunResponse | null;
  error: string | null;
}
