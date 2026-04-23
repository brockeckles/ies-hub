/**
 * IES Hub v3 — Supabase Client
 * Thin wrapper around @supabase/supabase-js (loaded via CDN as global).
 * Replaces v2's 784 raw supabase calls with a centralized client.
 *
 * Usage:
 *   import { db } from './supabase.js?v=20260418-sK';
 *
 *   const { data, error } = await db.from('cost_models').select('*').eq('id', 7);
 *   const rows = await db.fetchAll('labor_rates');
 *   await db.upsert('cost_models', record);
 *
 * @module shared/supabase
 */

const SUPABASE_URL = 'https://dklnwcshrpamzsybjlzb.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRrbG53Y3NocnBhbXpzeWJqbHpiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3MTU3NzksImV4cCI6MjA5MDI5MTc3OX0.mj9TIj_rwxfbb9e2vBnA6hNYot5MX8-k1BbGfddAeJs';

/**
 * Storage key for the Supabase auth session.
 * Namespaced per deployment so v2/v3 never cross-read.
 * Keep in sync with shared/auth.js.
 */
const SESSION_STORAGE_KEY = 'ies_hub_v3_sb_session';

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

  // Auth options are passed even before any user logs in — this just
  // tells the client *how* to track a session when one eventually lands.
  // Anonymous calls still work identically; tables without RLS lockdown
  // behave the same until Slice 3.3 tightens the policies.
  // @ts-ignore
  _client = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      // Persist across reload so users don't have to log in every tab.
      persistSession: true,
      autoRefreshToken: true,
      // Detect session from URL for future password-reset / magic-link
      // flows (Slice 3.6). Harmless when no auth params are present.
      detectSessionInUrl: true,
      storageKey: SESSION_STORAGE_KEY,
      // storage defaults to window.localStorage in browsers; spelled out
      // so we can swap to sessionStorage later if Security requires it.
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
};
