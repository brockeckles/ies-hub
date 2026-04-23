-- phase3_slice39_13_bucket_listing.sql
-- Slice 3.9 — tighten the `hub` storage bucket.
--
-- Advisor issue: `public_bucket_allows_listing` — the bucket has a broad
-- `Public read access` SELECT policy on `storage.objects` scoped to
-- `bucket_id='hub'`, letting any client enumerate every file in the bucket.
--
-- Uncovered during the grep-first review: the bucket ALSO has an
-- `Anon update access` UPDATE policy with the same predicate. That means
-- any anonymous caller can overwrite any object in the bucket. Worse than
-- the listing issue but not flagged by advisor (advisor only WARN is on
-- the SELECT). Killing both in the same migration.
--
-- Safety check: no client code in the v3 repo references the `hub` bucket.
-- Grep: `grep -rn "bucket_id.*hub\|'hub'.*storage\|storage.*'hub'"` → 0 hits.
-- The bucket itself is untouched; it holds a single legacy `index.html`
-- object (presumed leftover from an older deploy experiment) which is
-- preserved. After this migration, only service_role (and admin via
-- bucket-level admin paths) can reach objects in the bucket.

BEGIN;

DROP POLICY IF EXISTS "Public read access" ON storage.objects;
DROP POLICY IF EXISTS "Anon update access" ON storage.objects;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback (not applied):
-- ═══════════════════════════════════════════════════════════════════════════
-- BEGIN;
--   CREATE POLICY "Public read access" ON storage.objects
--     FOR SELECT TO public USING (bucket_id = 'hub'::text);
--   CREATE POLICY "Anon update access" ON storage.objects
--     FOR UPDATE TO public USING (bucket_id = 'hub'::text);
-- COMMIT;
