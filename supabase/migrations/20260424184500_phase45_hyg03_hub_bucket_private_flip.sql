-- Phase 4.5 Slice HYG-03 — flip legacy `hub` storage bucket to private
--
-- Background: the `hub` bucket was created 2026-03-29 as part of an early POC
-- path that served the HTML monolith via Supabase storage + an edge fn wrapper.
-- Production has since moved to GitHub Pages (https://brockeckles.github.io/ies-hub/).
-- The bucket holds a single stale `index.html` (681KB) last updated the day it
-- was created. HYG-01 already removed the anon-write policy on storage.objects;
-- this slice closes the remaining public-read exposure by flipping the bucket's
-- `public` flag to false. The `hub` edge fn has been redeployed in this same
-- slice as a 410 Gone tombstone, so the legacy /functions/v1/hub URL no longer
-- serves the stale HTML either.
--
-- Object is retained (cheap storage, now private, reversible) rather than deleted.
-- Advisor is already clean on both envs after HYG-01 + HYG-02; this slice should
-- not add or remove any advisor findings.

BEGIN;

UPDATE storage.buckets
   SET public = false
 WHERE id = 'hub';

COMMIT;
