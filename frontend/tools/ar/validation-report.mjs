/**
 * Scores REAL-camera validation exports against the pre-set acceptance thresholds.
 *
 *   npm run ar:report -- path/to/ar-validation-*.json [more files…]
 *
 * The files come from the camera page's developer readout (?debug=1 → Validation → Export). See
 * docs/HAND_AR_ACCURACY.md for how to collect them (held-out sessions; label each marking against a pen dot on the skin).
 */
import fs from 'node:fs';
import { analyzeValidation, VALIDATION_FORMAT } from '../../src/tracking/arValidation.js';

const files = process.argv.slice(2).filter((f) => !f.startsWith('--'));
if (!files.length) {
  console.error('usage: npm run ar:report -- <export.json> [more.json …]');
  process.exit(2);
}
const sessions = files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
const bad = sessions.filter((s) => s.format !== VALIDATION_FORMAT);
if (bad.length) { console.error(`not a ${VALIDATION_FORMAT} file:`, bad.length); process.exit(2); }

const r = analyzeValidation(sessions);
const f = (x, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const yes = (v) => (v == null ? 'not measured' : v ? 'PASS' : 'FAIL');
console.log(`REAL-CAMERA VALIDATION — ${files.length} file(s), ${r.alignment.n} labelled marking(s)`);
console.log(`alignment (palm widths): median ${f(r.alignment.median)}  p95 ${f(r.alignment.p95)}  max ${f(r.alignment.max)}  within ${r.thresholds.within}: ${f(r.alignment.withinRate * 100, 1)} %`);
for (const [k, s] of Object.entries(r.byView)) console.log(`  ${k.padEnd(28)} n=${s.n}  median ${f(s.median)}  p95 ${f(s.p95)}`);
console.log(`stationary jitter RMS: ${f(r.stationaryJitter)}   fps: ${f(r.fps, 1)}   detect ms: median ${f(r.detectMs.median, 1)} p95 ${f(r.detectMs.p95, 1)}`);
console.log(`tracking losses / minute: ${f(r.lossesPerMinute, 2)}   reacquisition (median): ${f(r.reacquireMs, 0)} ms`);
console.log('\nacceptance (thresholds fixed in src/tracking/arAcceptance.js):');
console.log(`  alignment ........ ${r.checks.alignment.pass ? 'PASS' : `FAIL — ${r.checks.alignment.fails.join('; ')}`}`);
console.log(`  stationary jitter  ${yes(r.checks.stationaryJitter)}`);
console.log(`  reacquisition .... ${yes(r.checks.reacquire)}`);
console.log(`  frame rate ....... ${yes(r.checks.fps)}`);
process.exit(Object.values(r.checks).some((c) => c === false || (c && c.pass === false)) ? 1 : 0);
