/**
 * IES Hub v3 — Supabase Client (environment-aware)
 *
 * Thin wrapper around @supabase/supabase-js (loaded via CDN as global).
 * Resolves prod vs staging project at runtime based on URL — so the same
 * built HTML can be deployed to either project's Pages path without a
 * build step.
 *
 * Detection order (first match wins):
 *   1. `?env=staging` or `?env=prod` query override (explicit test switch)
 *   2. hostname `localhost` / `127.0.0.1` / `0.0.0.0` → staging
 *   3. pathname contains `/ies-hub-staging` → staging
 *   4. otherwise → prod
 *
 * Slice 4.2 (Phase 4 — Deploy Hygiene). Before 4.2 this module had one
 * hard-coded prod URL.
 *
 * @module shared/supabase
 */

// ─── Per-environment configuration ───────────────────────────────────────
//
// Keep both projects' URLs + anon keys colocated. The anon key is a
// publishable credential by design (JWT-signed, RLS is the real boundary),
// so embedding it in the client is Supabase's recommended pattern.

const ENV_CONFIG = /** @type {const} */ ({
  prod: {
    name: 'prod',
    label: 'PROD',
    ref: 'dklnwcshrpamzsybjlzb',
    url: 'https://dklnwcshrpamzsybjlzb.supabase.co',
    anonKey:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRrbG53Y3NocnBhbXpzeWJqbHpiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3MTU3NzksImV4cCI6MjA5MDI5MTc3OX0.mj9TIj_rwxfbb9e2vBnA6hNYot5MX8-k1BbGfddAeJs',
  },
  staging: {
    name: 'staging',
    label: 'STAGING',
    ref: 'yswhxtpkfhvfbucyhads',
    url: 'https://yswhxtpkfhvfbucyhads.supabase.co',
    anonKey:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inlzd2h4dHBrZmh2ZmJ1Y3loYWRzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5NzkyMDMsImV4cCI6MjA5MjU1NTIwM30.f9RrfnqvFoU4Leipq4WOrEJ15ZFRmFosoA7ZRtwQYE4',
  },
});

/**
 * Pure env-detection. Exported for tests so we can feed it synthetic
 * URL-ish objects without mocking `window.location`.
 *
 * @param {{ hostname?: string, pathname?: string, search?: string }} [loc]
 * @returns {'prod' | 'staging'}
 */
export function detectEnv(loc) {
  const src = loc || ((typeof window !== 'undefined' && window.location) ? window.location : {});
  const hostname = (src.hostname || '').toLowerCase();
  const pathname = src.pathname || '';
  const search = src.search || '';

  // 1) Explicit `?env=staging` / `?env=prod` override. Useful for smoke-
  //    testing staging credentials from the prod URL without redeploying.
  const m = /[?&]env=(staging|prod)(?:&|$)/i.exec(search);
  if (m) return /** @type {'prod'|'staging'} */ (m[1].toLowerCase());

  // 2) Local dev / file:// → treat as staging so we never accidentally
  //    write to prod from a developer's laptop.
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '') {
    return 'staging';
  }

  // 3) Dedicated Pages path for staging (GitHub Pages convention).
  if (pathname.indexOf('/ies-hub-staging') !== -1) return 'staging';

  // 4) Default → prod.
  return 'prod';
}

/**
 * Resolve the active env config from the current window.location.
 * Cached because detection is pure but we call it a lot.
 * @returns {{ name: 'prod'|'staging', label: string, ref: string, url: string, anonKey: string }}
 */
let _envCfg = null;
function getEnvConfig() {
  if (_envCfg) return _envCfg;
  const name = detectEnv();
  _envCfg = ENV_CONFIG[name];
  return _envCfg;
}

/**
 * Public: which environment is the client pointed at right now?
 * Used by the admin header env chip (Slice 4.2) and will be reused by
 * the footer version badge (Slice 4.4).
 * @returns {'prod' | 'staging'}
 */
export function getEnv() {
  return getEnvConfig().name;
}

/**
 * Public: human label for the env chip.
 * @returns {'PROD' | 'STAGING'}
 */
export function getEnvLabel() {
  return /** @type {'PROD'|'STAGING'} */ (getEnvConfig().label);
}

/**
 * Public: the Supabase project ref (useful for logs / debugging).
 * @returns {string}
 */
export function getProjectRef() {
  return getEnvConfig().ref;
}

/**
 * Storage key for the Supabase auth session.
 *
 * Namespaced per deployment AND per env so v2/v3 never cross-read and a
 * staging session can't leak into a prod tab on the same origin. If you
 * switch env via `?env=staging`, you get a fresh session bucket — no
 * confused cross-env auth state.
 */
function getSessionStorageKey() {
  return `ies_hub_v3_sb_session_${getEnvConfig().name}`;
}

/** @type {import('@supabase/supabase-js').SupabaseClient | null} */
let _client = null;

/**
 * Get or create the Supabase client. Configured with persistent auth so
 * logging in on one tab survives reload and carries across tabs in the
 * same origin. Keep this singleton — two clients would fight over the
 * session.
 *
 * Requires supabase-js loaded as global `supabase`.
 * @returns {import('@supabase/supabase-js').SupabaseClient}
 */
function getClient() {
  if (_client) return _client;

  // @ts-ignore — supabase loaded via CDN as global
  if (typeof supabase === 'undefined' || !supabase.createClient) {
    throw new Error('Supabase JS library not loaded. Ensure the CDN script is included.');
  }

  const cfg = getEnvConfig();

  // One-line env trace at startup. Not noisy — the client is a singleton.
  try {
    // eslint-disable-next-line no-console
    console.info(`[supabase] env=${cfg.name} ref=${cfg.ref}`);
  } catch {}

  // @ts-ignore
  _client = supabase.createClient(cfg.url, cfg.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: getSessionStorageKey(),
      storage: (typeof window !== 'undefined' && window.localStorage) || undefined,
    },
  });
  return _client;
}

/**
 * Convenience: access supabase.from() directly.
 * @param {string} table
 */
function from(table) {
  return getClient().from(table);
}

/**
 * Fetch all rows from a table.
 * @param {string} table
 * @param {string} [select='*']
 * @returns {Promise<any[]>}
 */
async function fetchAll(table, select = '*') {
  const { data, error } = await from(table).select(select);
  if (error) {
    console.error(`[DB] fetchAll "${table}" failed:`, error);
    throw error;
  }
  return data || [];
}

/**
 * Fetch a single row by ID.
 * @param {string} table
 * @param {number|string} id
 * @param {string} [select='*']
 * @returns {Promise<any|null>}
 */
async function fetchById(table, id, select = '*') {
  const { data, error } = await from(table).select(select).eq('id', id).single();
  if (error) {
    if (error.code === 'PGRST116') return null; // not found
    console.error(`[DB] fetchById "${table}" id=${id} failed:`, error);
    throw error;
  }
  return data;
}

/**
 * Insert a row and return the inserted record.
 * @param {string} table
 * @param {Object} record
 * @returns {Promise<any>}
 */
async function insert(table, record) {
  const { data, error } = await from(table).insert(record).select().single();
  if (error) {
    console.error(`[DB] insert "${table}" failed:`, error);
    throw error;
  }
  return data;
}

/**
 * Update a row by ID.
 * @param {string} table
 * @param {number|string} id
 * @param {Object} updates
 * @returns {Promise<any>}
 */
async function update(table, id, updates) {
  const { data, error } = await from(table).update(updates).eq('id', id).select().single();
  if (error) {
    console.error(`[DB] update "${table}" id=${id} failed:`, error);
    throw error;
  }
  return data;
}

/**
 * Upsert (insert or update on conflict).
 * @param {string} table
 * @param {Object|Object[]} records
 * @param {Object} [opts]
 * @param {string} [opts.onConflict]
 * @returns {Promise<any[]>}
 */
async function upsert(table, records, opts = {}) {
  const arr = Array.isArray(records) ? records : [records];
  const query = from(table).upsert(arr, { onConflict: opts.onConflict });
  const { data, error } = await query.select();
  if (error) {
    console.error(`[DB] upsert "${table}" failed:`, error);
    throw error;
  }
  return data || [];
}

/**
 * Delete a row by ID.
 * @param {string} table
 * @param {number|string} id
 * @returns {Promise<void>}
 */
async function remove(table, id) {
  const { error } = await from(table).delete().eq('id', id);
  if (error) {
    console.error(`[DB] delete "${table}" id=${id} failed:`, error);
    throw error;
  }
}

/**
 * Call a Supabase RPC function.
 * @param {string} fnName
 * @param {Object} [params]
 * @returns {Promise<any>}
 */
async function rpc(fnName, params = {}) {
  const { data, error } = await getClient().rpc(fnName, params);
  if (error) {
    console.error(`[DB] rpc "${fnName}" failed:`, error);
    throw error;
  }
  return data;
}

/** The public DB API */
export const db = {
  getClient,
  from,
  fetchAll,
  fetchById,
  insert,
  update,
  upsert,
  remove,
  rpc,
  /** Env accessors (Slice 4.2) */
  getEnv,
  getEnvLabel,
  getProjectRef,
};
