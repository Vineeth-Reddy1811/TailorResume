#WORKFLOW CHECKLIST

1.  Lock the Markdown “house style” + convert resume once 

         Create your canonical `resume.md` (clean headings/bullets)
         This becomes the single source of truth for everything else

2.  Scaffold the app (Next.js + TS) + basic UI inputs 

         Textarea: base resume (preloaded from `resume.md`)
         Textarea: job description
         Textarea: extra instructions
         Button: Generate

3.  Backend endpoint v1: single-call LLM → proposed Markdown 

         `POST /api/generate`
         Returns `{ proposedResumeMarkdown }`
         Add the strict system rules (don’t change headings/dates, minimal edits, etc.)

4.  UI v1: show proposed output (no diff) 

         Just render it in a read-only textarea/preview
         Add “Copy to clipboard” (optional, very quick win)

5.  Add lightweight validation checks (before diff) 

         Detect if headings changed
         Detect if date lines changed (simple regex)
         If violated: show warnings (don’t block yet)

6.  Add Monaco DiffEditor (base vs proposed) 

         Left: base resume markdown
         Right: proposed markdown

7.  Accept all / Reject all 

         Accept all: overwrite base markdown with proposed
         Reject all: discard proposed, keep base
         Add “Reset to original base” (optional but helpful)

8.  Upgrade backend to two-pass generation (quality upgrade) 

         Pass A: extract job keywords/skills
         Pass B: edit resume with those keywords while keeping minimal edits
         Output still `{ proposedResumeMarkdown }` (keep UI unchanged)

9.  Switch response format to structured hunks 

         Backend returns `{ changes: [...] }`
         UI renders a change list + can apply changes to the base markdown
         (You can still keep DiffEditor as a “preview” of the current applied state)

10.  Per-hunk Accept/Reject 

         Accept: apply that hunk patch to the base (or working copy)
         Reject: ignore that hunk
         Add “Accept remaining” and “Undo last accept” (optional)

11.  Persistence (version history) 

         Save: base, JD, instructions, proposal, accepted final, timestamp
         Add “History” screen

12.  Export 

         Export Markdown → PDF
         Export Markdown → DOCX
         Add “download final” buttons



Markdown Resume Standard (House Style), Hard rules (do not break):
- # = Name only
- Contact line is a single line under the name (use pipes |)
- ## = Section headers only
- ### = Role/Project headers only
- Bullets use - only (no •, no *)
- Keep dates in the ### header line (so we can regex-protect them)
- No tables (diff noise)
- Keep consistent ordering: Summary → Skills → Experience → Projects → Education → Certifications
- Anything inside [[LOCK: ... ]] must never be changed by the LLM.