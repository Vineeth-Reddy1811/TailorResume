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
  downloads: {
    resume: string;
    report: string;
  };
}

export interface ApiError {
  error: string;
}
