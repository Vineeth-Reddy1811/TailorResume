# TailorResume
A project which will take in job description and tailor the resume accordingly.

## Deterministic resume tailoring

The tailoring planner uses no AI calls. You have authorized the app to treat a submitted job description as matching your real experience. It uses deterministic rules to recognize terms in categorized skill lists and qualification sections, then compares them with your resume and experience profile. Tailoring is additive: original skill lines and experience bullets stay intact, while new JD-aligned points are appended to the tailored copy.

1. If a requirement already appears in a Professional Experience or Projects bullet, keep that bullet unchanged.
2. If a profile fact maps to a related experience line, add a supplemental bullet after it and preserve the original wording.
3. If a submitted JD skill is missing, append it under an `Additional ...` heading in Technical Skills. Broad points such as frontend development are connected to relevant technologies already listed in the source resume.
4. If a technical skill is required and is not already evidenced in an experience/project bullet, add a contextual experience bullet as well. Preferred-only skills stay in Technical Skills.
5. Do not invent metrics, dates, employers, or outcomes. JD text is included as the user's authorized claim; the app does not independently verify it.

Use one command to generate the tailored DOCX and its change record and audit. The app applies all parsed JD points automatically without asking for approval per point:

```bash
npm run resume:tailor -- \
  --resume Data/input/resume/VineethResumeMay2026.docx \
  --job-description Data/input/job-description.example.txt \
  --experience-profile Data/input/experience-profile.json \
  --output Data/out/VineethResumeMay2026-tailored.docx
```

The command saves a sibling `VineethResumeMay2026-tailored-report` directory with the proposal, apply manifest, change history, and audit. Use `resume:propose` and `resume:apply` separately only when you want to inspect or customize the intermediate manifest.

Run the planner with a resume, job description, and verified profile:

```bash
npm run resume:propose -- \
  --resume Data/input/resume/VineethResumeMay2026.docx \
  --job-description Data/input/job-description.example.txt \
  --experience-profile Data/input/experience-profile.json \
  --output Data/out/tailoring-run
```

The profile format is documented in `Data/input/experience-profile.example.json`. A fact can specify `targetParagraphId` to add a supplemental line after a related source paragraph or `afterParagraphId` for a new bullet. Use `supplementText` to provide the contextual, human-readable add-on; the source paragraph stays unchanged. An optional source resume hash prevents paragraph IDs from being reused against a different file. New points learned from structured JD skill categories and qualification sections are saved in the profile for future runs.

Each run writes:

- `tailoring-proposal.json`: requirement decisions plus full proposed changes, including old/new wording, anchors, evidence, and status.
- `tailoring-proposal.md`: readable proposal and requirement summary.
- `tailoring-changes.json`: versioned, timestamped change record with source and job-description hashes, intended for the future diff UI.
- `tailoring-apply-manifest.json`: machine-readable changes accepted by the DOCX writer.

The source resume is never modified. Review the proposal, then apply it to a separate DOCX output:

```bash
npm run resume:apply -- \
  --resume Data/input/resume/VineethResumeMay2026.docx \
  --approved-additions Data/out/tailoring-run/tailoring-apply-manifest.json \
  --output Data/out/tailoring-run/VineethResumeMay2026-tailored.docx
```

The same manifest can be passed to `resume:audit` to check that only recorded additions were made and to report requirement coverage. Automatic tailoring appends `add-paragraph` entries to Technical Skills and `add-bullet` entries after related experience bullets. Existing core resume lines are not rewritten. The writer copies paragraph styles and bullet numbering from each anchor and preserves bold category labels on added skill lines.

The parser covers the recognized skill category headings and points under sections such as “What We’re Looking For.” It is deterministic, so arbitrary free-form JD wording and application questions may need parser support; the proposal reports parsed points and records every change. The user’s decision to submit the JD is the authorization policy, so the app does not ask for per-point confirmation.

## Remembering newly found skills and requirements

Normal proposal runs automatically save newly recognized terms and qualification points from a submitted job description in the persistent experience profile. The command below remains available for manually preloading a term before a matching JD is processed:

```bash
npm run resume:skill:confirm -- \
  --canonical "Snowflake" \
  --aliases "Snowflake Data Cloud" \
  --category "Tools & Platforms" \
  --source "User-confirmed experience"
```

This records a skill and aliases in `Data/input/experience-profile.json`. Future proposals merge these personal entries into their vocabulary and can append them to a tailored copy. Learned entries are user-authorized based on the submitted JD; the shared dictionary is not modified. If a process is forcibly stopped and leaves an `.lock` file, remove it only after confirming no profile update is running.

Extend or correct the deterministic matching vocabulary in `config/skill-dictionary.json`. `resume:convert` is the earlier Markdown normalization workflow and is retained for reference.

## Manual approval files

For manual edits outside the profile-based workflow, create a JSON file using `Data/input/approved-additions.example.json` and anchor each edit to a paragraph from the proposal report:

```json
{
  "sourceResume": "Data/input/resume/VineethResumeMay2026.docx",
  "sourceSha256": "56a817bdabef91cb95ea1f3fa92ea1b292d553961984469391fbe1df441e9a74",
  "additions": [
    {
      "id": "addition-001",
      "operation": "add-bullet",
      "afterParagraphId": "p-0019",
      "text": "Approved evidence-backed bullet text.",
      "source": "manual approval"
    }
  ]
}
```

For any non-empty additions list, include the source resume's 64-character SHA-256 from `tailoring-proposal.json`. The apply command rejects the manifest if the DOCX has changed since its paragraph IDs were created.

Apply manual changes to a new DOCX copy:

```bash
npm run resume:apply -- \
  --resume Data/input/resume/VineethResumeMay2026.docx \
  --approved-additions Data/input/approved-additions.json \
  --output Data/out/VineethResumeMay2026-tailored.docx
```

Use `operation: "add-bullet"` with `afterParagraphId` for a new bullet, `operation: "replace-bullet"` with `targetParagraphId` for a rewrite, or `operation: "replace-paragraph"` for a non-bullet paragraph. The writer copies the original package, keeps paragraph styles and bullet numbering, validates the resulting DOCX archive, and never overwrites the source resume.

## ATS focused copy and job match audit

For the current job description, the additional approved changes in `Data/input/ats-approved-changes.json` update the summary using evidence already in the resume, make the Delight Consulting role line easier to parse, and complete one sentence fragment in its Angular bullets. Both approval files refer to the original resume; the ATS file also checks its SHA-256 hash before applying paragraph IDs.

```bash
npm run resume:apply -- \
  --resume Data/input/resume/VineethResumeMay2026.docx \
  --approved-additions Data/input/approved-additions.json \
  --approved-additions Data/input/ats-approved-changes.json \
  --output Data/out/VineethResumeMay2026-ats.docx

npm run resume:audit -- \
  --source Data/input/resume/VineethResumeMay2026.docx \
  --resume Data/out/VineethResumeMay2026-ats.docx \
  --job-description Data/input/job-description.example.txt \
  --approved-additions Data/input/approved-additions.json \
  --approved-additions Data/input/ats-approved-changes.json \
  --output Data/out
```

The audit writes `ats-audit.md` and `ats-audit.json`. It checks that unedited paragraph text and DOCX parts outside `word/document.xml` are preserved, looks for common parsing hazards, and compares shared and learned JD terms against the original and tailored resumes. It is a local coverage report, not an employer ATS score. Submitted JD terms are marked user-authorized; the app does not independently validate them.
