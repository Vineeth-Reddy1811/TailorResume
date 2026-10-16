# TailorResume
A project which will take in job description and tailor the resume accordingly.

## Local React web app

The local app and hosted app are two runtime configurations of the same repository. They share the tailoring result contract, review panel, and workspace flow; local mode retains ChatGPT plan access and browser-local drafts, while hosted mode adds Google sign-in, account storage, provider settings, and queued runs. Keep product screens and tailoring behavior in shared components and services, and put storage, authentication, and AI connection differences behind the local or hosted runtime. Hosted-only account operations remain hosted-only.

The web app uses a hybrid skill detector: a local technical vocabulary scans the JD for known terms, and one batched ChatGPT Responses request classifies which matches are actual requirements and finds relevant terms the vocabulary does not yet contain. The same request drafts concise bullets per distinct resume achievement, linking related requirements to one bullet where the source supports them together. The local API listens only on `127.0.0.1`; the full JD and at most twelve resume experience bullets ranked for relevance are sent to OpenAI on each tailoring run. The model returns requirement IDs and a source excerpt, while the app verifies the excerpt and selects the actual DOCX paragraph. Invalid or near-duplicate drafts are reported against their requirements without discarding other valid changes.

Requirements: Node.js `22.12+` and npm. Install dependencies once, then start the app:

```bash
npm install
npm run web:dev
```

### Develop locally and deploy the same code

Make and review changes locally with `npm run web:dev`. Before pushing, run `npm run web:check`; this type-checks the web app and builds both the web client and server. GitHub Actions runs the same check on pushes and pull requests to `main`, and Render uses that same check when building the hosted service. Push the reviewed commit to GitHub to deploy that repository revision. Render selects hosted services through `APP_MODE=hosted`; local development keeps its local storage and ChatGPT connection. Do not commit `.env` files, credentials, personal resumes, or local session data.

On first launch, select **Continue with ChatGPT** and approve ChatGPT plan usage in the browser. TailorResume uses the signed-in account’s ChatGPT plan for eligible requests; it does not require an API key, use API-key billing, or silently switch to API billing. The plan’s connected-app usage limits still apply and are managed in [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage). TailorResume stores OAuth credentials in `~/.config/tailorresume/chatgpt-credentials.json` with owner-only permissions, never in browser storage, and supports disconnecting the app in its UI. The stable host ID and issued client registration are retained for future sign-ins. The model catalog is queried with the ChatGPT access token and cached for five minutes; it prefers `gpt-6-luna` when available and `OPENAI_MODEL` in an optional `.env` can select another model available to the connected account. The detector and any experience drafting share one inference request per run. Requests set `store: false` and stream through completion. The local server reports model and token counts but does not log resume or JD text.

Open the local URL printed by Vite (normally `http://127.0.0.1:5173`). Upload a `.docx` resume and paste a job description. Review the change record, coverage summary, and full tailored resume preview with edited lines highlighted before downloading the DOCX. The API accepts resumes up to 15 MB and job descriptions up to 30,000 characters to bound AI usage. Results are temporary: active runs expire after one hour and are deleted during graceful shutdown. If the server exits unexpectedly, a startup and periodic sweep removes expired run folders owned by this app.

The interface follows the operating system’s color preference by default. Use the theme control in the top bar to cycle between System, Light, and Dark; your choice is saved in this browser. UI colors are defined as semantic CSS custom properties in `web/src/styles.css` (for example, `--text-primary`, `--surface`, `--border`, and `--accent`). New components should use these tokens so the active theme applies automatically.

The selected resume and job description are autosaved in this browser’s IndexedDB and restored when you reload or restart the local app. This local draft expires after seven days and can be removed with **Clear saved session**. Tailored output files remain temporary and need to be regenerated after the server stops.

AI source excerpts are stored as provenance in the change record and review panel. They are checked against an eligible resume bullet but are kept separate from proposed resume text.

The local web app builds a profile from a selected resume and lets you confirm detected skills in the UI. Its experience and project lines remain visible as evidence; new experience claims must still be grounded in those lines or a user-confirmed profile fact. The CLI continues to accept `Data/input/experience-profile.json` for advanced workflows. Newly discovered job vocabulary is stored separately: local runs save entries in the ignored `Data/skill-catalog.learned.json`; hosted runs use the shared Supabase `skill_catalog` table. The source-controlled `config/skill-dictionary.json` remains the starter vocabulary. Catalog membership does not verify personal experience. Hosted shared catalog review is available only to the configured catalog owner; local mode allows review on that computer. The catalog stores terms, aliases, categories, role areas, definitions, and source counts, not resume text or job-description excerpts. To enable hosted catalog learning, apply both `supabase/migrations/20261015000100_shared_skill_catalog.sql` and `supabase/migrations/20261015000200_atomic_skill_catalog_review.sql` in timestamp order, then set `TAILORRESUME_CATALOG_ADMIN_EMAIL` in Render to the email on the owner account. Hosted learned terms stay pending until the owner approves them; approvals are serialized and reject aliases already used by an active term. Broad competencies such as SDLC are drafted under an existing experience/project role rather than saved as skills. Personal source files and generated outputs remain excluded by `.gitignore`.

This workflow is the local single-user mode. Hosted mode uses Supabase account storage and provider keys; set `APP_MODE=hosted` only in the hosted deployment. Do not expose a local-mode server to the internet.

## Hosted foundation (Supabase + Render)

The repository now includes a Render Free service blueprint, Supabase schema migrations, Google sign-in, and account-scoped cloud resume/profile storage. Signed-in users upload/download/remove their own base resume; on upload, the server extracts recognized skills from the DOCX and saves the personal profile automatically. Users do not need to create or edit an experience-profile JSON file in hosted mode. Newly discovered job vocabulary is saved to the shared `skill_catalog`, separately from each account's experience profile. They can save Claude, Grok, and OpenAI API keys, encrypted by the server and scoped to their own account, and choose an available model. Hosted tailoring supports Claude and OpenAI API: after consent, the server sends the full JD and at most twelve relevant experience bullets to the selected provider, then stores the tailored DOCX and preview under that account. Users may also redeem an invitation for three runs using TailorResume's shared OpenAI API key. That key and invitation code are server-only Render settings; the code is redeemed once per account and the run allowance is enforced atomically in Supabase. OpenAI API usage is separate from ChatGPT Plus; hosted runs do not use the local ChatGPT plan connection and never fall back between billing methods. Grok key storage is available, but Grok tailoring, cancellation, account export/deletion, and persistent rate quotas remain future work. Runs allow one active job per account, survive page reloads and queued jobs resume after a service restart; a run interrupted while processing is marked failed. Run records and generated files are deleted after 30 days by an hourly cleanup sweep while the service is running, and also at startup. Users can delete a completed run sooner. The shared local experience-profile file is still used only by the local CLI workflow.

### Configure a staging deployment

1. Create a Supabase project and apply all SQL files in [`supabase/migrations`](supabase/migrations) in timestamp order, including `20261012000300_initial_platform_ai_access.sql`. This creates owner-scoped profile/resume/run tables, a private `resume-files` bucket, row-level security policies, secure provider-credential functions, AI-consent recording, the one-active-run-per-account constraint, coordinated run/resume lifecycle operations, and atomic saving of the uploaded resume with its extracted profile. The platform AI migration adds a private run allowance record and service-only atomic functions; it does not drop or recreate existing tables. The OpenAI migration enables the provider in the existing encrypted-key flow; the profile upload migration does not backfill existing profile data. The migrations do not move any files from your computer.
2. In Supabase Auth, enable Google as a provider. Create a Google OAuth web client. In Google Cloud, set its authorized redirect URI to `https://<your-project-ref>.supabase.co/auth/v1/callback`. In Supabase Auth URL configuration, set **Site URL** to the Render origin (for example, `https://tailorresume.onrender.com`) and add `https://tailorresume.onrender.com/auth/google/callback` to **Redirect URLs**.
3. In Render, create a web service from this repository and use the included `render.yaml` blueprint. Set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, and `PUBLIC_APP_URL` in Render's environment settings. The Supabase secret key is server-only and bypasses row-level security, so the backend uses it only after authenticating the user and filtering credential queries by that user's ID. A legacy `SUPABASE_SERVICE_ROLE_KEY` can be used if the project does not yet have a Supabase secret key. Generate a 32-byte server encryption key with `openssl rand -hex 32` and set it as `AI_CREDENTIAL_ENCRYPTION_KEY`; keep a secure backup because saved provider keys depend on it. For shared AI access, set `TAILORRESUME_PLATFORM_AI_API_KEY` to your OpenAI API key, `TAILORRESUME_PLATFORM_AI_MODEL` to an API model available to that key, and `TAILORRESUME_INITIAL_AI_ACCESS_CODE` to the invitation code `InitialUser1811`. These values must be stored in Render environment settings, never in the repository or browser. Each signed-in account can redeem the invitation once for three runs. Set Google OAuth client credentials in Supabase Auth, not in this repository. Never put a Supabase secret/service-role key in the browser or commit it to git.
3. In Render, create a web service from this repository and use the included `render.yaml` blueprint. Set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, and `PUBLIC_APP_URL` in Render's environment settings. The Supabase secret key is server-only and bypasses row-level security, so the backend uses it only after authenticating the user and filtering credential queries by that user's ID. A legacy `SUPABASE_SERVICE_ROLE_KEY` can be used if the project does not yet have a Supabase secret key. Generate a 32-byte server encryption key with `openssl rand -hex 32` and set it as `AI_CREDENTIAL_ENCRYPTION_KEY`; keep a secure backup because saved provider keys depend on it. For shared AI access, set `TAILORRESUME_PLATFORM_AI_API_KEY` to your OpenAI API key, `TAILORRESUME_PLATFORM_AI_MODEL` to an API model available to that key, and `TAILORRESUME_INITIAL_AI_ACCESS_CODE` to the invitation code `InitialUser1811`. Set `TAILORRESUME_CATALOG_ADMIN_EMAIL` to the email address of the one account allowed to approve shared vocabulary. These values must be stored in Render environment settings, never in the repository or browser. Each signed-in account can redeem the invitation once for three runs. Set Google OAuth client credentials in Supabase Auth, not in this repository. Never put a Supabase secret/service-role key in the browser or commit it to git.
4. Confirm `/api/health` reports `mode: "hosted"`, then sign in with Google. Upload a base DOCX; recognized skills are extracted and saved automatically. Users can connect their own Claude/OpenAI API key in the separate AI settings page, or redeem the shared AI invitation there. Choose the AI funding source in the tailoring form and consent to sending the JD plus up to twelve relevant resume experience bullets to that provider. The DOCX and generated profile remain in TailorResume storage. After a run completes, the app opens a separate results page with an account-checked preview/download; that page can be refreshed or bookmarked until the run expires after 30 days. Grok keys can be saved, but Grok tailoring is not wired yet.

Use sample accounts and documents during this staging phase. Supabase Auth/DB/Storage configuration and all migrations are prerequisites; this repository does not connect to or deploy into your Supabase or Render accounts automatically. Keep public use closed until account isolation, operational limits, account deletion/export, and production security reviews are complete.

The hosted app derives its callback URL from `PUBLIC_APP_URL`, requires HTTPS in production, and honors Render's `PORT`. Local mode continues to bind to `127.0.0.1` unless explicitly configured otherwise.

## Resume tailoring workflow

You have authorized the app to treat a submitted job description as matching your real experience. Local rules scan the expanded technical-skill catalog and profile; OpenAI classifies actual JD requirements, discovers uncatalogued skills in unstructured descriptions, and drafts missing required skills or broad competencies from eligible resume bullets in the same request. The app gives the model up to twelve resume bullets selected by requirement and JD relevance. Every classified skill is linked to a JD excerpt in the change report. Original experience bullets and skill lines remain intact. Each requirement receives a stable ID in the report. A draft is accepted only when its quoted source excerpt matches a locally selected eligible bullet and its wording passes validation; unresolved requirements remain listed with a reason. Preferred-only skills do not receive experience drafts, and the app does not generate generic bullets when no source-grounded draft is available.

1. If a requirement already appears in a Professional Experience or Projects bullet, keep that bullet unchanged.
2. If a profile fact maps to a related experience line, add a supplemental bullet after it and preserve the original wording.
3. If a technical skill is missing, add it to the closest matching existing labeled row in Technical Skills, without creating a new subsection or unlabeled catch-all line. Broad competencies such as SDLC are added under a relevant experience or project role.
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

The profile format is documented in `Data/input/experience-profile.example.json`. A fact can specify `targetParagraphId` to add a supplemental line after a related source paragraph or `afterParagraphId` for a new bullet. Use `supplementText` to provide the contextual, human-readable add-on; the source paragraph stays unchanged. An optional source resume hash prevents paragraph IDs from being reused against a different file. The end-to-end `resume:tailor` command saves eligible new vocabulary after the DOCX and audit succeed; `resume:propose` only stages candidates in its report. Broad competencies are not stored as skills.

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

The same manifest can be passed to `resume:audit` to check that only recorded additions were made and to report requirement coverage. Automatic tailoring merges missing skill names into matching existing Technical Skills rows and adds experience bullets after existing role bullets. It does not create a `Core Competencies` or `Additional ...` subsection. Skill-row updates are recorded as before/after changes, preserving the bold category label. The writer copies paragraph styles and bullet numbering from each anchor.

The checked-in catalog starts with common software engineering languages, frameworks, data stores, cloud platforms, architecture, testing, security, and tools. AI can also classify terms for Business Analysis and other professional roles, including terms found in unstructured JD text. After a successful run, new terms are persisted for future matching; hosted terms wait for the catalog owner’s approval, while clear local terms may become active automatically. Ambiguous terms and alias conflicts wait in the local review queue. Catalog entries are not personal experience evidence. The user’s decision to submit the JD is the authorization policy, so the app does not ask for per-point confirmation when drafting from supported resume evidence.

## Remembering newly found skills and requirements

Successful local end-to-end runs save clear discovered terms and aliases in `Data/skill-catalog.learned.json`; hosted runs save them to Supabase `skill_catalog` for owner review. Pending terms do not match future JDs until reviewed. Failed runs do not update the catalog. Vocabulary is stored separately from the personal verified experience profile. Broad experience competencies are not stored as skills. The command below remains available for manually preloading a personally verified skill before a matching JD is processed:

```bash
npm run resume:skill:confirm -- \
  --canonical "Snowflake" \
  --aliases "Snowflake Data Cloud" \
  --category "Tools & Platforms" \
  --source "User-confirmed experience"
```

This records a skill and aliases in `Data/input/experience-profile.json`. Future proposals merge these personal entries into their vocabulary and can add them to the matching existing Technical Skills row. Learned entries are user-authorized based on the submitted JD; the shared dictionary is not modified. If a process is forcibly stopped and leaves an `.lock` file, remove it only after confirming no profile update is running.

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
