/* Test runner.
 *
 *   node run.mjs              every suite
 *   node run.mjs draw         only the suites that touch the Draw view
 *   node run.mjs unit         the two that need no browser at all (seconds)
 *   node run.mjs v9 v11       named suites
 *   node run.mjs --live draw  ignore the fixtures and hit the real API
 *   node run.mjs --record v6  top the fixture set up with whatever v6 asks for
 *
 * Areas exist so that a CSS tweak does not have to re-run the bracket maths.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const AREAS = {
  unit:     ['test_bracket', 'test_surname'],
  matches:  ['v10', 'v11', 'v12', 'final'],
  players:  ['v2', 'v3', 'v4', 'v5', 'v7', 'v8'],
  draw:     ['v2', 'v9', 'v11'],
  predict:  ['v9', 'v11'],
  names:    ['test_surname', 'v8', 'v11', 'final'],
  schedule: ['v10', 'v11', 'v6', 'v7'],
  nav:      ['v11', 'v7', 'v6'],
  live:     ['v12'],
  h2h:      ['v13', 'v2', 'v3'],
  all:      ['test_bracket', 'test_surname', 'v2', 'v3', 'v4', 'v5', 'v6',
             'v7', 'v8', 'v9', 'v10', 'v11', 'v12', 'v13', 'final'],
};

const args = process.argv.slice(2);
const live = args.includes('--live');
const record = args.includes('--record');
const names = args.filter(a => !a.startsWith('--'));

let suites;
if (!names.length) suites = AREAS.all;
else {
  suites = [];
  for (const n of names) {
    if (AREAS[n]) suites.push(...AREAS[n]);
    else suites.push(n.replace(/\.mjs$/, ''));
  }
  suites = [...new Set(suites)];
}

const env = { ...process.env };
if (record) env.FIXTURES = 'record';
if (live) env.FIXTURES = 'live';

console.log(`running ${suites.length} suite(s)${record ? ' [RECORDING]' : live ? ' [LIVE]' : ''}: ${suites.join(' ')}\n`);

const t0 = Date.now();
let failed = [];
for (const s of suites) {
  const started = Date.now();
  process.stdout.write(s.padEnd(14));
  const out = await new Promise(res => {
    const p = spawn(process.execPath, [path.join(HERE, s + '.mjs')], { env, cwd: HERE });
    let buf = '';
    p.stdout.on('data', d => { buf += d; });
    p.stderr.on('data', d => { buf += d; });
    p.on('close', code => res({ buf, code }));
  });
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  const verdict = /ALL CHECKS PASSED/.test(out.buf) ? 'pass'
    : (out.buf.match(/FAILURES: \d+/) || ['crash'])[0];
  const fixtures = (out.buf.match(/fixtures (?:served|recorded): [^\n]*/) || [''])[0];
  if (verdict !== 'pass') failed.push(s);
  console.log(`${verdict.padEnd(12)} ${secs}s   ${fixtures}`);
  if (verdict !== 'pass') {
    const lines = out.buf.split('\n').filter(l => /^FAIL|EXC |LOG /.test(l)).slice(0, 8);
    // A suite that dies before its first check has no FAIL lines at all, and
    // printing nothing sends you off to re-run the whole set to find out why.
    // Chrome losing a debugging port is transient; a real break is not, and
    // from a bare "crash" the two are indistinguishable.
    if (!lines.length) {
      lines.push(`exit ${out.code}, no checks reported — tail:`,
        ...out.buf.trimEnd().split('\n').slice(-6));
    }
    console.log(lines.map(l => '    ' + l).join('\n'));
  }
}

console.log(`\n${suites.length - failed.length}/${suites.length} passed in ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`);
if (failed.length) console.log('failed: ' + failed.join(' '));
process.exit(failed.length ? 1 : 0);
