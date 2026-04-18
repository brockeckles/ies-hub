/**
 * IES Hub v3 — Shared Export Module
 *
 * CSV and XLSX export helpers shared across Design Tools.
 *
 * CSV: pure string assembly, no dependency.
 * XLSX: thin wrapper over SheetJS (window.XLSX, loaded as a global in index.html).
 *
 * Usage:
 *   import { downloadCSV, downloadXLSX } from '../../shared/export.js?v=...';
 *
 *   downloadCSV([
 *     { name: 'Lane A', miles: 1200, cost: 4500 },
 *     { name: 'Lane B', miles: 800,  cost: 3200 },
 *   ], {
 *     filename: 'fleet-lanes.csv',
 *     columns: [
 *       { key: 'name', label: 'Lane Name' },
 *       { key: 'miles', label: 'Miles' },
 *       { key: 'cost', label: 'Annual Cost', format: 'currency' },
 *     ],
 *   });
 *
 *   downloadXLSX({
 *     filename: 'cog-scenario.xlsx',
 *     sheets: [
 *       { name: 'Summary',   rows: summaryRows },
 *       { name: 'Demand',    rows: demandRows, columns: [...] },
 *     ],
 *   });
 *
 * @module shared/export
 */

/**
 * @typedef {Object} ExportColumn
 * @property {string} key                    row field name
 * @property {string} [label]                column header (defaults to key)
 * @property {'string'|'number'|'currency'|'pct'|'date'} [format]
 * @property {number} [decimals]             for number/pct/currency (default 0 for currency, 2 for pct, 2 for number)
 * @property {(value:any, row:object) => any} [transform]  pre-format transform
 */

/**
 * @typedef {Object} XLSXSheet
 * @property {string} name
 * @property {Array<object>} rows
 * @property {ExportColumn[]} [columns]  — if omitted, uses Object.keys(rows[0])
 * @property {number[]} [colWidths]       — optional column widths in characters
 */

/**
 * Convert an array of row objects into a CSV string.
 * @param {object[]} rows
 * @param {ExportColumn[]} [columns]
 * @returns {string}
 */
export function toCSV(rows, columns) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const cols = normalizeColumns(rows, columns);
  const header = cols.map(c => csvEscape(c.label || c.key)).join(',');
  const body = rows.map(r =>
    cols.map(c => csvEscape(renderCell(r, c))).join(',')
  ).join('\n');
  return header + '\n' + body;
}

/**
 * Trigger a browser download of the given rows as a CSV file.
 * @param {object[]} rows
 * @param {{ filename: string, columns?: ExportColumn[] }} opts
 */
export function downloadCSV(rows, opts) {
  const { filename = 'export.csv', columns } = opts || {};
  const csv = toCSV(rows, columns);
  // Excel/Numbers recognize UTF-8 with BOM.
  const blob = new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8;' });
  triggerBlobDownload(blob, filename);
}

/**
 * Build a multi-sheet XLSX workbook via SheetJS and trigger download.
 * Requires window.XLSX (loaded globally in index.html).
 * Silently falls back to the first sheet as CSV if SheetJS is unavailable.
 *
 * @param {{ filename: string, sheets: XLSXSheet[] }} opts
 */
export function downloadXLSX(opts) {
  const { filename = 'export.xlsx', sheets = [] } = opts || {};
  if (!sheets.length) return;

  const XLSX = /** @type {any} */ (typeof window !== 'undefined' ? window.XLSX : null);
  if (!XLSX || !XLSX.utils || !XLSX.writeFile) {
    console.warn('[export] SheetJS not available — falling back to CSV of first sheet');
    const first = sheets[0];
    downloadCSV(first.rows || [], {
      filename: filename.replace(/\.xlsx$/i, '.csv'),
      columns: first.columns,
    });
    return;
  }

  const wb = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const cols = normalizeColumns(sheet.rows, sheet.columns);
    const headerRow = cols.map(c => c.label || c.key);
    const bodyRows = (sheet.rows || []).map(r => cols.map(c => renderCellRaw(r, c)));
    const aoa = [headerRow, ...bodyRows];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    if (sheet.colWidths?.length) {
      ws['!cols'] = sheet.colWidths.map(w => ({ wch: w }));
    } else {
      ws['!cols'] = cols.map(c => ({ wch: Math.max((c.label || c.key).length + 2, 14) }));
    }
    XLSX.utils.book_append_sheet(wb, ws, safeSheetName(sheet.name || 'Sheet'));
  }
  XLSX.writeFile(wb, filename);
}

// ---- Helpers ----

function normalizeColumns(rows, columns) {
  if (Array.isArray(columns) && columns.length) return columns;
  if (!Array.isArray(rows) || !rows.length) return [];
  return Object.keys(rows[0]).map(k => ({ key: k }));
}

function renderCell(row, col) {
  let v = row[col.key];
  if (typeof col.transform === 'function') v = col.transform(v, row);
  if (v == null) return '';
  const fmt = col.format || 'string';
  switch (fmt) {
    case 'currency': return fmtCurrency(v, col.decimals);
    case 'number':   return fmtNumber(v, col.decimals ?? 2);
    case 'pct':      return fmtPct(v, col.decimals ?? 1);
    case 'date':     return fmtDate(v);
    default:         return String(v);
  }
}

// Raw (native) cell value for XLSX — keep numbers as numbers so Excel formats them.
function renderCellRaw(row, col) {
  let v = row[col.key];
  if (typeof col.transform === 'function') v = col.transform(v, row);
  if (v == null) return '';
  const fmt = col.format || 'string';
  if (fmt === 'currency' || fmt === 'number' || fmt === 'pct') {
    const n = Number(v);
    return Number.isFinite(n) ? n : '';
  }
  if (fmt === 'date') {
    try { return new Date(v); } catch { return v; }
  }
  return v;
}

function fmtCurrency(v, decimals) {
  const d = decimals ?? 0;
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return '$' + n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtNumber(v, decimals) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
function fmtPct(v, decimals) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + '%';
}
function fmtDate(v) {
  try {
    const d = v instanceof Date ? v : new Date(v);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return String(v); }
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  // Quote if field contains comma, double-quote, or newline.
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replaceAll('"', '""') + '"';
  }
  return s;
}

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
}

function safeSheetName(name) {
  // Excel sheet name constraints: max 31 chars, no : \ / ? * [ ]
  return String(name).replace(/[:\\/?*\[\]]/g, '-').slice(0, 31);
}

export default { toCSV, downloadCSV, downloadXLSX };
