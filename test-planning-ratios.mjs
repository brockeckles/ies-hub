// test-planning-ratios.mjs — regression for shared/planning-ratios.js
// Covers lookupRatio (override chain + applicability scoring + SCD effective-date),
// ratioValue convenience helper, resolvePlanningRatios bulk resolver,
// countRatioOverrides, isStale source_date detection, and groupByCategory.
import {
  lookupRatio,
  ratioValue,
  resolvePlanningRatios,
  countRatioOverrides,
  isStale,
  groupByCategory,
} from './shared/planning-ratios.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

// A small synthetic catalog that exercises: NULL applicability, filtered rows,
// multiple rows with different effective dates, and structured values.
const catalog = [
  // Universal Ops Manager span: 1 per 75 FTE
  { id: 1, category_code: 'labor_spans', ratio_code: 'salary.operations_manager.span',
    display_name: 'Ops Mgr', value_type: 'scalar', numeric_value: 75, value_unit: 'FTE/mgr',
    vertical: null, environment_type: null, automation_level: null, market_tier: null,
    source: 'Reference template', source_date: '2018-03-01',
    effective_date: '2018-01-01', effective_end_date: '9999-12-31',
    sort_order: 140, is_active: true },

  // Specialty retail-specific Ops Manager: tighter span at 1 per 60
  { id: 2, category_code: 'labor_spans', ratio_code: 'salary.operations_manager.span',
    display_name: 'Ops Mgr (Retail)', value_type: 'scalar', numeric_value: 60, value_unit: 'FTE/mgr',
    vertical: 'specialty_retail', environment_type: null, automation_level: null, market_tier: null,
    source: 'Internal analysis', source_date: '2023-01-01',
    effective_date: '2023-01-01', effective_end_date: '9999-12-31',
    sort_order: 140, is_active: true },

  // Seasonality — retail profile (structured)
  { id: 10, category_code: 'seasonality', ratio_code: 'seasonality.monthly_share',
    display_name: 'Retail Seasonality', value_type: 'array',
    numeric_value: null,
    value_jsonb: [0.065, 0.073, 0.086, 0.081, 0.081, 0.086, 0.083, 0.091, 0.093, 0.079, 0.088, 0.093],
    vertical: 'specialty_retail', environment_type: null, automation_level: null, market_tier: null,
    source: 'Reference template', source_date: '2010-01-01',
    effective_date: '2010-01-01', effective_end_date: '9999-12-31',
    sort_order: 20, is_active: true },

  // SCD: an older row that expired. Should NOT match when asOf > end.
  { id: 20, category_code: 'labor_mix', ratio_code: 'labor.pto_allowance',
    display_name: 'PTO (old)', value_type: 'percent', numeric_value: 0.03,
    vertical: null, environment_type: null, automation_level: null, market_tier: null,
    source: 'Reference template', source_date: '2018-03-01',
    effective_date: '2018-01-01', effective_end_date: '2022-12-31',
    sort_order: 180, is_active: true },

  // PTO: newer row valid today
  { id: 21, category_code: 'labor_mix', ratio_code: 'labor.pto_allowance',
    display_name: 'PTO (current)', value_type: 'percent', numeric_value: 0.05,
    vertical: null, environment_type: null, automation_level: null, market_tier: null,
    source: 'Internal analysis', source_date: '2023-01-01',
    effective_date: '2023-01-01', effective_end_date: '9999-12-31',
    sort_order: 180, is_active: true },
];

const categories = [
  { code: 'labor_spans', display_name: 'Spans', sort_order: 10 },
  { code: 'labor_mix', display_name: 'Labor Mix', sort_order: 20 },
  { code: 'seasonality', display_name: 'Seasonality', sort_order: 160 },
];

// ── 1. Basic lookup — universal row, no context ──
{
  const r = lookupRatio('salary.operations_manager.span', {}, catalog, {});
  t('universal row matches with empty context', r.source === 'default' && r.value === 75);
}

// ── 2. Applicability scoring — vertical-specific wins ──
{
  const r = lookupRatio('salary.operations_manager.span', { vertical: 'specialty_retail' }, catalog, {});
  t('vertical-specific row wins over universal', r.source === 'default' && r.value === 60 && r.def.id === 2);
}

// ── 3. Applicability scoring — unrelated vertical falls through to universal ──
{
  const r = lookupRatio('salary.operations_manager.span', { vertical: 'industrial' }, catalog, {});
  t('unrelated vertical falls back to universal', r.source === 'default' && r.value === 75);
}

// ── 4. Override wins over default ──
{
  const ov = { 'salary.operations_manager.span': { value: 50, note: 'narrow floor' } };
  const r = lookupRatio('salary.operations_manager.span', {}, catalog, ov);
  t('override wins over catalog', r.source === 'override' && r.value === 50 && r.override.note === 'narrow floor');
}

// ── 5. Override coerces string to number for scalar rows ──
{
  const ov = { 'salary.operations_manager.span': { value: '45' } };
  const r = lookupRatio('salary.operations_manager.span', {}, catalog, ov);
  t('override coerces string to number', r.value === 45);
}

// ── 6. Override passes through for structured values ──
{
  const customProfile = [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.0, 0.0, 0.0];
  const ov = { 'seasonality.monthly_share': { value: customProfile } };
  const r = lookupRatio('seasonality.monthly_share', { vertical: 'specialty_retail' }, catalog, ov);
  t('structured override passes through', r.source === 'override' && Array.isArray(r.value) && r.value.length === 12);
}

// ── 7. Missing code returns source='missing' ──
{
  const r = lookupRatio('does.not.exist', {}, catalog, {});
  t('missing code returns {source:missing,value:null}', r.source === 'missing' && r.value === null && r.def === null);
}

// ── 8. SCD — current date resolves the active row ──
{
  const r = lookupRatio('labor.pto_allowance', { asOf: '2026-04-19' }, catalog, {});
  t('SCD picks current-era row', r.source === 'default' && r.value === 0.05 && r.def.id === 21);
}

// ── 9. SCD — historical date picks the expired row ──
{
  const r = lookupRatio('labor.pto_allowance', { asOf: '2020-06-01' }, catalog, {});
  t('SCD picks expired row for historical asOf', r.source === 'default' && r.value === 0.03 && r.def.id === 20);
}

// ── 10. SCD — when old row is gone AND asOf is after new effective_date, new row wins ──
{
  // 2023-06-01 is past end date of old row AND past effective of new row → new row only.
  const r = lookupRatio('labor.pto_allowance', { asOf: '2023-06-01' }, catalog, {});
  t('SCD picks new row when old is expired', r.value === 0.05);
}

// ── 11. ratioValue convenience helper ──
{
  t('ratioValue returns the value',
    ratioValue('salary.operations_manager.span', {}, catalog, {}) === 75);
  t('ratioValue applies fallback when missing',
    ratioValue('does.not.exist', {}, catalog, {}, 99) === 99);
}

// ── 12. resolvePlanningRatios bulk map ──
{
  const map = resolvePlanningRatios(catalog, {}, { vertical: 'specialty_retail' });
  t('bulk resolve includes all unique codes',
    Object.keys(map).sort().join(',') === 'labor.pto_allowance,salary.operations_manager.span,seasonality.monthly_share');
  t('bulk resolve applies vertical-specific match',
    map['salary.operations_manager.span'].value === 60);
}

// ── 13. countRatioOverrides ──
{
  t('counts empty overrides as 0', countRatioOverrides({}) === 0);
  t('counts only rows with a value', countRatioOverrides({
    a: { value: 10 },
    b: { value: null },   // no value
    c: { value: '' },     // empty string
    d: { value: 0 },      // zero is a valid override!
  }) === 2);
}

// ── 14. isStale — pre-2022 source ──
{
  const staleRow = { source_date: '2018-03-01' };
  const freshRow = { source_date: '2023-05-01' };
  const noDate = { source_date: null };
  t('pre-2022 row flagged stale', isStale(staleRow) === true);
  t('post-2022 row not stale', isStale(freshRow) === false);
  t('no source_date -> not stale', isStale(noDate) === false);
}

// ── 15. groupByCategory ──
{
  const grouped = groupByCategory(catalog, categories);
  t('groupByCategory preserves category sort order',
    grouped.map(g => g.category.code).join(',') === 'labor_spans,labor_mix,seasonality');
  t('groupByCategory bucketizes rows',
    grouped[0].rows.length === 2 &&
    grouped[1].rows.length === 2 &&
    grouped[2].rows.length === 1);
  t('groupByCategory sorts rows by sort_order within category',
    grouped[1].rows[0].id === 20 || grouped[1].rows[0].sort_order <= grouped[1].rows[1].sort_order);
}

// ── 16. Catalog with no match (all disqualified) returns missing ──
{
  // A row that REQUIRES vertical=automotive will not match when context has
  // vertical=industrial. Since no universal row exists for this code, result
  // is missing.
  const isolatedCatalog = [{
    id: 999, category_code: 'labor_spans', ratio_code: 'only.automotive',
    display_name: 'Auto-only', value_type: 'scalar', numeric_value: 100,
    vertical: 'automotive', environment_type: null, automation_level: null, market_tier: null,
    source: 'x', source_date: '2023-01-01',
    effective_date: '2020-01-01', effective_end_date: '9999-12-31',
    sort_order: 10, is_active: true,
  }];
  const r = lookupRatio('only.automotive', { vertical: 'industrial' }, isolatedCatalog, {});
  t('all-disqualified returns missing', r.source === 'missing');
}

// ── Summary ──
console.log(`\n\nplanning-ratios: ${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);
