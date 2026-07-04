// test-deal-context.mjs — pure regression for shared/deal-context.js (UX-1 / D2)
//
// Runs under node with no window/localStorage: exercises the in-memory
// fallback, then fakes localStorage + window.location.hash to cover the
// browser paths (garbage tolerance, URL deep-link override).

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.error('  ✗ ' + name); }
}

// ── Phase 1: node fallback store (no localStorage yet) ──────────────────
const dc = await import('./shared/deal-context.js');

check('getActive null when unset', dc.getActive() === null);
check('setActive rejects missing id', dc.setActive({ name: 'x' }) === null);
check('setActive rejects null', dc.setActive(null) === null);

let events = [];
const off = dc.onChange((ctx) => events.push(ctx));

const ctx = dc.setActive({ id: 42, name: 'Hearthwood Home — Omnichannel FC', customer: 'Hearthwood Home Co.' });
check('setActive returns ctx', !!ctx && ctx.id === '42');
check('id coerced to string', typeof ctx.id === 'string');
check('getActive roundtrip', dc.getActive()?.name === 'Hearthwood Home — Omnichannel FC');
check('isActive true (number arg)', dc.isActive(42) === true);
check('isActive true (string arg)', dc.isActive('42') === true);
check('isActive false other id', dc.isActive('43') === false);
check('onChange fired with ctx', events.length === 1 && events[0]?.id === '42');

dc.setActive({ id: 'uuid-abc' });
check('re-set replaces', dc.getActive()?.id === 'uuid-abc');
check('optional sugar null when omitted', dc.getActive()?.name === null);

dc.clearActive();
check('clearActive → null', dc.getActive() === null);
check('onChange fired with null', events[events.length - 1] === null);
check('isActive false after clear', dc.isActive('uuid-abc') === false);

off();
dc.setActive({ id: 'after-off' });
check('unsubscribe works', events.filter(e => e && e.id === 'after-off').length === 0);
dc.clearActive();

// ── Phase 2: fake localStorage — garbage tolerance ───────────────────────
// deal-context resolves the store lazily on every call, so installing a
// fake localStorage NOW is honored by the already-imported module.
const backing = new Map();
globalThis.localStorage = {
  getItem: (k) => (backing.has(k) ? backing.get(k) : null),
  setItem: (k, v) => backing.set(k, String(v)),
  removeItem: (k) => backing.delete(k),
};

backing.set('ies_active_deal', '{not json');
check('garbage JSON → null', dc.getActive() === null);
backing.set('ies_active_deal', JSON.stringify({ nope: 1 }));
check('missing id → null', dc.getActive() === null);
backing.set('ies_active_deal', JSON.stringify({ id: 'd-9', name: 'Wayfair — Memphis FC', setAt: 5 }));
check('valid stored ctx read', dc.getActive()?.id === 'd-9');
check('stored via fake localStorage not mem', dc.getActive()?.name === 'Wayfair — Memphis FC');

// ── Phase 3: URL deep-link override ──────────────────────────────────────
globalThis.window = { location: { hash: '#designtools/cost-model?deal=d-9' } };
check('URL id matching stored keeps sugar', dc.getActive()?.name === 'Wayfair — Memphis FC');
globalThis.window.location.hash = '#designtools/cost-model?deal=d-77';
check('URL id wins over stored', dc.getActive()?.id === 'd-77');
check('URL-only ctx has bare shape', dc.getActive()?.name === null);
globalThis.window.location.hash = '#designtools/cost-model?x=1&deal=d-88';
check('deal amid other params', dc.getActive()?.id === 'd-88');
globalThis.window.location.hash = '#designtools/cost-model';
check('no query → stored again', dc.getActive()?.id === 'd-9');
globalThis.window.location.hash = '#designtools/cost-model?deal=';
check('empty deal param ignored', dc.getActive()?.id === 'd-9');

// readDealFromUrl direct
globalThis.window.location.hash = '#deals?deal=abc-123';
check('readDealFromUrl parses', dc.readDealFromUrl() === 'abc-123');

console.log(`test-deal-context: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
