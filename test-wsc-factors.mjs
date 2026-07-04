// test-wsc-factors.mjs — N2 factor pinning/drift coverage (2026-07-04).
// Pins the pinWscFactors/wscFactorsDrift contract (CM House-Assumptions
// governance applied to the WSC catalog) + the seed-migration contract.
import { readFileSync } from 'node:fs';
import { pinWscFactors, wscFactorsDrift, wscFactorValue } from './tools/warehouse-sizing/factors-calc.js';
import { DEPTH_BUCKETS, DEFAULT_PEAK_FACTOR, DEFAULT_ABC } from './tools/warehouse-sizing/profile-calc.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

const LIVE = [
  { category_code: 'wsc_media_selection', ratio_code: 'wsc.media.rule_of_3', display_name: 'Rule of 3',
    value_type: 'scalar', numeric_value: '3', value_unit: 'x lane depth', value_jsonb: null,
    source: 'vendor heuristic', source_detail: '3D Storage', source_date: '2026-05-01', sort_order: 10 },
  { category_code: 'wsc_dynamics', ratio_code: 'wsc.dock.mulcahy_safety_factor', display_name: 'Mulcahy SF',
    value_type: 'scalar', numeric_value: '1.25', value_unit: 'x', value_jsonb: null,
    source: 'industry method', source_detail: 'Mulcahy', source_date: '2026-07-04', sort_order: 10 },
  { category_code: 'wsc_dynamics', ratio_code: 'wsc.aisle.widths_by_mhe_ft', display_name: 'Aisle widths',
    value_type: 'lookup', numeric_value: null, value_unit: 'ft',
    value_jsonb: { counterbalance: { min: 12, max: 13 }, reach: { min: 8, max: 10 } },
    source: 'industry method', source_detail: 'Conger', source_date: '2026-07-04', sort_order: 80 },
];

// ── pin ──
{
  const p = pinWscFactors(LIVE, '2026-07-04');
  t('pinnedAt honored', p.pinnedAt === '2026-07-04');
  t('rows count 3', p.rows.length === 3);
  t('numeric coerced to Number', p.rows.find(r => r.ratio_code === 'wsc.media.rule_of_3').numeric_value === 3);
  t('jsonb preserved', p.rows.find(r => r.ratio_code === 'wsc.aisle.widths_by_mhe_ft').value_jsonb.reach.max === 10);
  t('sorted by category then sort_order', p.rows[0].category_code === 'wsc_dynamics' && p.rows[0].sort_order === 10);
  t('default pinnedAt is ISO date', /^\d{4}-\d{2}-\d{2}$/.test(pinWscFactors(LIVE).pinnedAt));
}

// ── value accessor ──
{
  const p = pinWscFactors(LIVE);
  t('scalar value read', wscFactorValue(p, 'wsc.media.rule_of_3') === 3);
  t('lookup value read', wscFactorValue(p, 'wsc.aisle.widths_by_mhe_ft').counterbalance.min === 12);
  t('unknown code null', wscFactorValue(p, 'wsc.nope') === null);
  t('null pinned null', wscFactorValue(null, 'wsc.media.rule_of_3') === null);
}

// ── drift ──
{
  const p = pinWscFactors(LIVE, '2026-07-04');
  const same = wscFactorsDrift(p, LIVE);
  t('no drift when unchanged', same.anyDrift === false);
  t('no added when unchanged', same.added.length === 0);

  // numeric change
  const bumped = LIVE.map(r => r.ratio_code === 'wsc.dock.mulcahy_safety_factor' ? { ...r, numeric_value: '1.5' } : r);
  const d1 = wscFactorsDrift(p, bumped);
  t('numeric drift detected', d1.anyDrift === true);
  t('changed row flagged', d1.rows.find(r => r.ratio_code === 'wsc.dock.mulcahy_safety_factor').changed === true);
  t('other rows unflagged', d1.rows.find(r => r.ratio_code === 'wsc.media.rule_of_3').changed === false);
  t('current attached', d1.rows.find(r => r.changed).current.numeric_value === '1.5');

  // jsonb change
  const jb = LIVE.map(r => r.ratio_code === 'wsc.aisle.widths_by_mhe_ft'
    ? { ...r, value_jsonb: { counterbalance: { min: 12, max: 13 }, reach: { min: 8, max: 9 } } } : r);
  t('jsonb drift detected', wscFactorsDrift(p, jb).rows.find(r => r.ratio_code === 'wsc.aisle.widths_by_mhe_ft').changed === true);

  // removal + addition
  const removed = LIVE.slice(1);
  const d2 = wscFactorsDrift(p, removed);
  t('missing flagged', d2.rows.find(r => r.ratio_code === 'wsc.media.rule_of_3').missing === true);
  t('missing => anyDrift', d2.anyDrift === true);
  const extended = [...LIVE, { ...LIVE[0], ratio_code: 'wsc.media.new_thing' }];
  const d3 = wscFactorsDrift(p, extended);
  t('added surfaced', d3.added.length === 1 && d3.added[0].ratio_code === 'wsc.media.new_thing');
  t('added => anyDrift', d3.anyDrift === true);
  t('string-vs-number numeric equal is NOT drift', wscFactorsDrift(p, LIVE.map(r => ({ ...r }))).anyDrift === false);
}

// ── seed-migration contract ──
{
  const sql = readFileSync('./migrations/wsc_factor_catalog_seed_2026-07-04.sql', 'utf8');
  for (const code of [
    'wsc.media.rule_of_3', 'wsc.media.depth_to_media_map', 'wsc.media.cost_per_position_usd',
    'wsc.dock.mulcahy_safety_factor', 'wsc.staging.min_sqft_per_door', 'wsc.aisle.widths_by_mhe_ft',
    'wsc.flue.default_standard', 'wsc.flue.fm_ds8_9', 'wsc.flue.nfpa_13', 'wsc.egress.s1_travel_ft',
    'wsc.profile.default_peak_factor', 'wsc.profile.default_abc_split', 'wsc.grid.column_spacing_ft',
  ]) t(`seed contains ${code}`, sql.includes(`'${code}'`));
  t('seed FM default (Brock decision)', sql.includes('"default":"FM"'));
  t('seed namespace-delete idempotency', sql.includes("DELETE FROM ref_planning_ratios WHERE ratio_code LIKE 'wsc.%'"));
  t('seed peak factor mirrors profile-calc', sql.includes(`'scalar',${DEFAULT_PEAK_FACTOR},'x'`) || sql.includes(`'scalar',1.35,'x'`));
  t('profile-calc default peak is 1.35', DEFAULT_PEAK_FACTOR === 1.35);
  t('seed ABC mirrors profile-calc', sql.includes(`"linePct":${DEFAULT_ABC.A.linePct}`));
  // depth map buckets mirror DEPTH_BUCKETS boundaries
  for (const b of DEPTH_BUCKETS.slice(0, 4)) t(`seed depth bucket min ${b.min}`, sql.includes(`"minPltPerSku":${b.min}`));
}

console.log(`\ntest-wsc-factors: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
