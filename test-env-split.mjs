// test-env-split.mjs — R12 (2026-04-30) environment-split helper
//
// Locks the behavior of api.js _splitEnvironment so future refactors of the
// cost_model_projects schema can't silently mis-route legacy environment
// values to the wrong column. Pure-function test, no network.
//
// Run: node test-env-split.mjs

// Shim window so shared/supabase.js loads without a browser
globalThis.window = globalThis.window || { location: { hostname: '', pathname: '/', search: '' } };

const mod = await import('./tools/cost-model/api.js?test=1');
const { _splitEnvironment } = mod;

let passed = 0;
let failed = 0;
const fails = [];
function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    fails.push(`${label}: expected ${e}, got ${a}`);
    console.log(`  ✗ ${label}: expected ${e}, got ${a}`);
  }
}

console.log('\n── _splitEnvironment — explicit new fields ─────────────────');

eq('explicit storageEnvironment routes to storage',
   _splitEnvironment({ storageEnvironment: 'refrigerated' }, {}),
   { storage: 'refrigerated', vertical: null, legacy: 'refrigerated' });

eq('explicit vertical routes to vertical',
   _splitEnvironment({ vertical: 'retail' }, {}),
   { storage: null, vertical: 'retail', legacy: 'retail' });

eq('both new fields populate independently',
   _splitEnvironment({ storageEnvironment: 'ambient', vertical: 'ecommerce' }, {}),
   { storage: 'ambient', vertical: 'ecommerce', legacy: 'ambient' });

console.log('\n── _splitEnvironment — legacy single field auto-route ──────');

eq('legacy "ambient" routes to storage',
   _splitEnvironment({ environment: 'ambient' }, {}),
   { storage: 'ambient', vertical: null, legacy: 'ambient' });

eq('legacy "ecommerce" routes to vertical',
   _splitEnvironment({ environment: 'ecommerce' }, {}),
   { storage: null, vertical: 'ecommerce', legacy: 'ecommerce' });

eq('legacy "retail" routes to vertical',
   _splitEnvironment({ environment: 'retail' }, {}),
   { storage: null, vertical: 'retail', legacy: 'retail' });

eq('legacy "refrigerated" routes to storage',
   _splitEnvironment({ environment: 'refrigerated' }, {}),
   { storage: 'refrigerated', vertical: null, legacy: 'refrigerated' });

eq('legacy "freezer" routes to storage',
   _splitEnvironment({ environment: 'freezer' }, {}),
   { storage: 'freezer', vertical: null, legacy: 'freezer' });

eq('legacy "industrial" routes to vertical',
   _splitEnvironment({ environment: 'industrial' }, {}),
   { storage: null, vertical: 'industrial', legacy: 'industrial' });

console.log('\n── _splitEnvironment — alias normalization ─────────────────');

eq('"food & beverage" → food_beverage',
   _splitEnvironment({ environment: 'food & beverage' }, {}),
   { storage: null, vertical: 'food_beverage', legacy: 'food_beverage' });

eq('"consumer goods" → consumer_goods',
   _splitEnvironment({ environment: 'consumer goods' }, {}),
   { storage: null, vertical: 'consumer_goods', legacy: 'consumer_goods' });

eq('"pharma" → pharmaceutical',
   _splitEnvironment({ environment: 'pharma' }, {}),
   { storage: null, vertical: 'pharmaceutical', legacy: 'pharmaceutical' });

eq('"cold" → refrigerated',
   _splitEnvironment({ environment: 'cold' }, {}),
   { storage: 'refrigerated', vertical: null, legacy: 'refrigerated' });

eq('"frozen" → freezer',
   _splitEnvironment({ environment: 'frozen' }, {}),
   { storage: 'freezer', vertical: null, legacy: 'freezer' });

eq('"temp controlled" → temperature_controlled',
   _splitEnvironment({ environment: 'temp controlled' }, {}),
   { storage: 'temperature_controlled', vertical: null, legacy: 'temperature_controlled' });

console.log('\n── _splitEnvironment — case insensitivity ──────────────────');

eq('UPPERCASE "AMBIENT" routes correctly',
   _splitEnvironment({ environment: 'AMBIENT' }, {}),
   { storage: 'ambient', vertical: null, legacy: 'ambient' });

eq('TitleCase "Refrigerated" routes correctly',
   _splitEnvironment({ environment: 'Refrigerated' }, {}),
   { storage: 'refrigerated', vertical: null, legacy: 'refrigerated' });

console.log('\n── _splitEnvironment — explicit overrides legacy ──────────');

eq('explicit storageEnvironment beats legacy environment',
   _splitEnvironment({ storageEnvironment: 'freezer', environment: 'ambient' }, {}),
   { storage: 'freezer', vertical: null, legacy: 'freezer' });

eq('explicit vertical beats legacy environment',
   _splitEnvironment({ vertical: 'retail', environment: 'ecommerce' }, {}),
   { storage: null, vertical: 'retail', legacy: 'retail' });

console.log('\n── _splitEnvironment — empty + invalid inputs ──────────────');

eq('empty pd returns all null',
   _splitEnvironment({}, {}),
   { storage: null, vertical: null, legacy: null });

eq('null environment returns all null',
   _splitEnvironment({ environment: null }, {}),
   { storage: null, vertical: null, legacy: null });

eq('unknown legacy "unknown" drops both axes; legacy preserved',
   _splitEnvironment({ environment: 'unknown' }, {}),
   { storage: null, vertical: null, legacy: 'unknown' });

eq('invalid storageEnvironment value → all null (sanitized)',
   _splitEnvironment({ storageEnvironment: 'tropical' }, {}),
   { storage: null, vertical: null, legacy: null });

eq('invalid vertical value → all null (sanitized)',
   _splitEnvironment({ vertical: 'something_else' }, {}),
   { storage: null, vertical: null, legacy: null });

console.log('\n── _splitEnvironment — top-level data fallback ─────────────');

eq('top-level data.environment as fallback',
   _splitEnvironment({}, { environment: 'ambient' }),
   { storage: 'ambient', vertical: null, legacy: 'ambient' });

eq('top-level data.storageEnvironment populated',
   _splitEnvironment({}, { storageEnvironment: 'freezer' }),
   { storage: 'freezer', vertical: null, legacy: 'freezer' });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  fails.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log('R12 environment-split helper invariants pass ✓');
