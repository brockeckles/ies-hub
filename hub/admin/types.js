/**
 * IES Hub v3 — Admin Panel Types
 * JSDoc typedefs for master data tables, user management, and system config.
 *
 * @module hub/admin/types
 */

/**
 * @typedef {Object} MasterTableConfig
 * @property {string} id — table key (e.g. 'cost_buckets')
 * @property {string} name — display name
 * @property {string} description
 * @property {string} tableName — Supabase table name
 * @property {ColumnDef[]} columns
 * @property {number} rowCount
 */

/**
 * @typedef {Object} ColumnDef
 * @property {string} key — field name
 * @property {string} label — display label
 * @property {'text' | 'number' | 'boolean' | 'select' | 'date'} type
 * @property {boolean} [required]
 * @property {boolean} [editable] — false = read-only
 * @property {string[]} [options] — for select type
 */

/**
 * @typedef {Object} MasterRecord
 * @property {string} id
 * @property {Record<string, any>} data
 * @property {string} [created_at]
 * @property {string} [updated_at]
 */

/**
 * @typedef {Object} UserAccount
 * @property {string} id
 * @property {string} email
 * @property {string} displayName
 * @property {'admin' | 'editor' | 'viewer'} role
 * @property {boolean} active
 * @property {string} [lastLogin]
 * @property {string} [created_at]
 */

/**
 * @typedef {Object} EscalationRule
 * @property {string} id
 * @property {string} name
 * @property {string} metric — what metric to watch (e.g. 'gross_margin_pct')
 * @property {'above' | 'below'} condition
 * @property {number} threshold
 * @property {'warning' | 'critical'} severity
 * @property {boolean} active
 * @property {string} [notifyEmail]
 */

/**
 * @typedef {Object} AuditLogEntry
 * @property {string} id
 * @property {string} action — 'create' | 'update' | 'delete'
 * @property {string} tableName
 * @property {string} recordId
 * @property {string} userId
 * @property {string} userName
 * @property {string} timestamp — ISO datetime
 * @property {Record<string, any>} [changes] — diff of changed fields
 */

/**
 * @typedef {Object} AdminStats
 * @property {number} totalUsers
 * @property {number} activeUsers
 * @property {number} totalTables
 * @property {number} totalRecords
 * @property {number} activeEscalations
 * @property {number} recentAuditEntries — last 7 days
 */

export {};
