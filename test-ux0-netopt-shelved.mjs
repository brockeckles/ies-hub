/**
 * UX0-5 (2026-07-03) — NetOpt shelved (unified-plan decision #9).
 * Feature-flag pattern: landing card hidden, search entry removed, COG
 * send button hidden. Code, route, and netopt_configs tables stay intact
 * for reversal.
 */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function t(name, fn) {
  try { if (fn() === false) throw new Error('returned false'); pass++; }
  catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); }
}

const html = readFileSync('./index.html', 'utf8');
const search = readFileSync('./shared/search.js', 'utf8');
const cogUi = readFileSync('./tools/center-of-gravity/ui.js', 'utf8');

t('netopt card carries shelved flag', () => /'network-opt'.*shelved: true/.test(html));
t('landing catalog filters shelved tools', () => html.includes('_allTools.filter(t => !t.shelved)'));
t('route still registered (reversal path)', () => html.includes("'designtools/network-opt'"));
t('tool module still on disk', () => readFileSync('./tools/network-opt/ui.js', 'utf8').length > 1000);
t('search index no longer lists NetOpt', () => !search.includes("route: 'designtools/network-opt'"));
t('COG Send-to-NetOpt button hidden, handler kept', () =>
  !/id="cog-push-netopt"/.test(cogUi) && /cog-push-netopt/.test(cogUi));

t('Command Center quick links no longer list NetOpt', () =>
  !readFileSync('./hub/command-center/ui.js', 'utf8').includes("designtools/network-opt"));

console.log(`test-ux0-netopt-shelved: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
