/* Unit-test surnameOf()/cardName() — the real functions lifted out of app.js —
   against every one of the 416 entrants, plus the known-awkward cases. */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const HERE = path.dirname(fileURLToPath(import.meta.url));

const src = fs.readFileSync(path.join(HERE, '..', 'app.js'), 'utf8');
const grab = name => {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('not found: ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1);
  }
};
const teamName = new Function('return ' + grab('teamName'))();
const surnameOf = new Function('return ' + grab('surnameOf'))();
const cardName = new Function('teamName', 'surnameOf', 'return ' + grab('cardName'))(teamName, surnameOf);

let fail = 0;
const eq = (label, got, want) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  →  "${got}"${ok ? '' : `   (expected "${want}")`}`);
};

console.log('=== the ordinary shapes ===');
eq('given + SURNAME',        surnameOf('Thom GICQUEL'), 'GICQUEL');
eq('SURNAME first (CHN)',    surnameOf('SHI Yu Qi'), 'SHI');
eq('SURNAME first (KOR)',    surnameOf('KIM Won Ho'), 'KIM');
eq('two given names',        surnameOf('Jonathan Bing Tsan LAI'), 'LAI');
eq('SURNAME + two given',    surnameOf('GADDE Ruthvika Shivani'), 'GADDE');
eq('accented caps',          surnameOf('Alexandra BØJE'), 'BØJE');

console.log('\n=== the sixteen awkward ones ===');
eq('compound (Egyptian)',    surnameOf('Nour AHMED YOUSSRI'), 'AHMED YOUSSRI');
eq('compound (Malay)',       surnameOf('Fadilah Shamika MOHAMED RAFI'), 'MOHAMED RAFI');
eq('compound (Dutch tussenvoegsel)', surnameOf('Kelly VAN BUITEN'), 'VAN BUITEN');
eq('compound (Dutch, short)', surnameOf('Kirsten DE WIT'), 'DE WIT');
eq('compound leading',       surnameOf('DE GUZMAN Mikaela Joy'), 'DE GUZMAN');
eq('compound (Chinese-Malay)', surnameOf('Serena AU YEONG'), 'AU YEONG');
eq('leading initials',       surnameOf('M.R. ARJUN'), 'ARJUN');
eq('middle initial',         surnameOf('PUSARLA V. Sindhu'), 'PUSARLA');
eq('disambiguator suffix',   surnameOf('VU Thi Trang (B)'), 'VU');
eq('all caps (Burmese)',     surnameOf('THET HTAR THUZAR'), 'THET HTAR THUZAR');
eq('all caps (Chinese)',     surnameOf('CHEN ZHI YI'), 'CHEN ZHI YI');
eq('all caps (Indian)',      surnameOf('GAYATRI GOPICHAND PULLELA'), 'GAYATRI GOPICHAND PULLELA');

console.log('\n=== cardName: pairs shorten, singles do not ===');
const pair = (a, b) => ({ players: [{ nameDisplay: a }, { nameDisplay: b }] });
const solo = a => ({ players: [{ nameDisplay: a }] });
eq('XD pair',   cardName(pair('FENG Yan Zhe', 'HUANG Dong Ping')), 'FENG / HUANG');
eq('MD pair',   cardName(pair('KIM Won Ho', 'SEO Seung Jae')), 'KIM / SEO');
eq('WD pair',   cardName(pair('LIU Sheng Shu', 'TAN Ning')), 'LIU / TAN');
eq('FRA XD pair', cardName(pair('Thom GICQUEL', 'Delphine DELRUE')), 'GICQUEL / DELRUE');
eq('same surname twice', cardName(pair('Christo POPOV', 'Toma Junior POPOV')), 'POPOV / POPOV');
eq('singles untouched', cardName(solo('Anders ANTONSEN')), 'Anders ANTONSEN');
eq('singles untouched (CHN)', cardName(solo('SHI Yu Qi')), 'SHI Yu Qi');
eq('empty side', cardName(null), 'TBD');
eq('teamName still full', teamName(pair('Thom GICQUEL', 'Delphine DELRUE')),
   'Thom GICQUEL / Delphine DELRUE');

console.log('\n=== every entrant in the five draws ===');
const names = JSON.parse(fs.readFileSync(path.join(HERE, 'names.json'), 'utf8'));
const all = Object.values(names).flat();
let empty = 0, unchanged = 0, longest = '';
for (const n of all) {
  const s = surnameOf(n);
  if (!s) { empty++; console.log('  EMPTY for: ' + n); }
  if (s === n && n.split(/\s+/).length > 1) unchanged++;
  if (s.length > longest.length) longest = s;
}
console.log(`  ${all.length} names, ${empty} produced nothing, ${unchanged} kept whole (all-caps)`);
console.log(`  longest surname produced: "${longest}" (${longest.length} chars)`);
if (empty) fail++;
console.log(`${empty === 0 ? 'PASS' : 'FAIL'}  every entrant yields a surname`);

// The point of the change: a doubles card has to fit ~26 characters at 208px.
const dbl = [...names.md, ...names.wd, ...names.xd];
const pairs = [];
for (let i = 0; i + 1 < dbl.length; i += 2) pairs.push(cardName(pair(dbl[i], dbl[i + 1])));
const over = pairs.filter(p => p.length > 26);
console.log(`\n  ${pairs.length} sample pairs; ${over.length} still longer than 26 chars`);
over.slice(0, 8).forEach(p => console.log('    ' + p));
const before = [];
for (let i = 0; i + 1 < dbl.length; i += 2) before.push(teamName(pair(dbl[i], dbl[i + 1])));
console.log(`  average length: ${(before.reduce((a,b)=>a+b.length,0)/before.length).toFixed(1)}` +
            ` → ${(pairs.reduce((a,b)=>a+b.length,0)/pairs.length).toFixed(1)} chars`);

console.log(fail ? `\nFAILURES: ${fail}` : '\nALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
