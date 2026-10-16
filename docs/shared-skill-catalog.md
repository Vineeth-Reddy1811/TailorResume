# Shared skill catalog

The checked-in `config/skill-dictionary.json` is the starter vocabulary. Hosted runs seed its entries into `public.skill_catalog`, then combine the seed with active shared entries for the next JD analysis. Local web and `resume:tailor` runs use the same seed plus the ignored `Data/skill-catalog.learned.json` file.

After a successful run, uncatalogued terms returned by the AI are checked against the JD excerpt, allowed role areas/categories, term length, aliases, and existing catalog aliases. Every new hosted term is saved with `status = 'pending'`; only owner-approved entries can match in future runs. This keeps AI-generated aliases out of shared matching until review and avoids concurrent runs activating colliding aliases. No JD excerpts or resume content are stored in this shared catalog.

## Review queue

Apply `supabase/migrations/20261015000100_shared_skill_catalog.sql` and then `supabase/migrations/20261015000200_atomic_skill_catalog_review.sql` in Supabase SQL Editor. The table and approval function are service-role only; signed-in users cannot read or change shared entries directly. The approval function serializes approvals and refuses any term whose aliases overlap an active catalog entry. Set `TAILORRESUME_CATALOG_ADMIN_EMAIL` in the hosted service to the email address of the catalog owner. That signed-in account can review pending entries in the TailorResume workspace. Review aliases, category, role area, definition, and reason before approving. Rejected terms stay rejected and are not automatically reactivated. Local mode exposes the same review UI for the private local catalog.

The app never treats catalog membership as proof of a user's experience. Resume evidence and the existing tailoring rules continue to decide which experience claims can appear in a tailored resume.
