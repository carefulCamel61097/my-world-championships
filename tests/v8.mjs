/* Both halves of a doubles pair must show the pair's ranking. */
import http from 'node:http'; import fs from 'node:fs';
import { fileURLToPath } from 'node:url'; import path from 'node:path';
import { spawn } from 'node:child_process';
import { installFixtures, fixtureReport } from './fixtures.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), PORT = 8792, DBG = 9364;
const CHROME='C:/Program Files/Google/Chrome/Application/chrome.exe';
const TYPES={'.html':'text/html','.js':'text/javascript','.css':'text/css'};
const server=http.createServer((q,s)=>{const rel=decodeURIComponent(q.url.split('?')[0].split('#')[0]);
  const f=path.join(ROOT, rel==='/'?'index.html':rel);
  fs.readFile(f,(e,b)=>{ if(e){s.writeHead(404);s.end('nf');return;}
    s.writeHead(200,{'Content-Type':TYPES[path.extname(f)]||'application/octet-stream'}); s.end(b);});});
await new Promise(r=>server.listen(PORT,r));
const profile=path.join(process.env.TEMP,'wc26-v8-'+Date.now());
const chrome=spawn(CHROME,['--no-first-run','--no-default-browser-check','--window-position=-2400,0',
  '--window-size=1400,1000',`--user-data-dir=${profile}`,`--remote-debugging-port=${DBG}`,'about:blank']);
chrome.stderr.on('data',()=>{});
let wsUrl=null; for(let i=0;i<60&&!wsUrl;i++){await new Promise(r=>setTimeout(r,400));
  try{wsUrl=(await(await fetch(`http://127.0.0.1:${DBG}/json/version`)).json()).webSocketDebuggerUrl;}catch{}}
const ws=new WebSocket(wsUrl); await new Promise(r=>ws.addEventListener('open',r,{once:true}));
let fx = null;
let id=0; const pending=new Map(); const events=[];
ws.addEventListener('message',e=>{const m=JSON.parse(e.data);
  if(m.id&&pending.has(m.id)){pending.get(m.id)(m.result);pending.delete(m.id);} else if(m.method){ events.push(m); if(fx) fx.handle(m); }});
const send=(m,p={},s)=>new Promise(r=>{const i=++id;pending.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p,sessionId:s}));});
const {targetId}=await send('Target.createTarget',{url:'about:blank'});
const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
await send('Runtime.enable',{},sessionId); await send('Log.enable',{},sessionId); await send('Page.enable',{},sessionId);
fx = await installFixtures(send, sessionId, { quiet: true });
const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true},sessionId);
  if(r?.exceptionDetails) return {__err:r.exceptionDetails.text}; return r?.result?.value;};
const wait=ms=>new Promise(r=>setTimeout(r,ms));

// XD: Thom GICQUEL (68544, listed first) + Delphine DELRUE (70762, listed second)
// WD: LIU Sheng Shu (81599, first) + TAN Ning (59880, second)
await send('Page.navigate',{url:`http://localhost:${PORT}/#p=68544,70762,81599,59880&c=all&v=players`},sessionId);
await wait(12000);
await ev(`(() => { const b = [...document.querySelectorAll('.subtab')].find(x => x.dataset.ptab === 'list'); if (b) b.click(); })()`);
await wait(4500);

let fail=0; const check=(l,c,x='')=>{ if(!c)fail++; console.log(`${c?'PASS':'FAIL'}  ${l}${x?'  — '+x:''}`); };

async function statsFor(nameRe) {
  await ev(`(() => { const r=[...document.querySelectorAll('.mp')].find(x=>/${nameRe}/.test(x.textContent));
    if(r) r.click(); })()`);
  await wait(9000);
  return ev(`({
    hero: (document.querySelector('.phero-txt h2')||{}).textContent||'',
    cells: [...document.querySelectorAll('.stat-cell')].map(c=>
      (c.querySelector('.k')||{}).textContent.trim()+'='+(c.querySelector('.v')||{}).textContent.trim())
  })`);
}

console.log('=== mixed doubles ===');
const man = await statsFor('GICQUEL');
console.log('  ', JSON.stringify(man));
const woman = await statsFor('DELRUE');
console.log('  ', JSON.stringify(woman));
const rankOf = s => (s.cells.find(c=>/^BWF World Ranking/.test(c))||'').split('=')[1]||'';
const highOf = s => (s.cells.find(c=>/^Career high/.test(c))||'').split('=')[1]||'';
check('man has a ranking', /^#\d+/.test(rankOf(man)), rankOf(man));
check('woman has a ranking too', /^#\d+/.test(rankOf(woman)), rankOf(woman));
check('both show the same pair ranking', rankOf(man)===rankOf(woman), `${rankOf(man)} vs ${rankOf(woman)}`);
check('woman gets a career high', /^#\d+/.test(highOf(woman)), highOf(woman));
check('career highs match', highOf(man)===highOf(woman), `${highOf(man)} vs ${highOf(woman)}`);
check('ranking labelled as the pair\'s', man.cells.some(c=>/pair/.test(c)), man.cells[0]);

console.log('\n=== level doubles (same failure mode) ===');
const first = await statsFor('LIU Sheng Shu');
const second = await statsFor('TAN Ning');
console.log('  ', JSON.stringify(first.cells));
console.log('  ', JSON.stringify(second.cells));
check('first-named has a ranking', /^#\d+/.test(rankOf(first)), rankOf(first));
check('second-named has one too', /^#\d+/.test(rankOf(second)), rankOf(second));
check('both match', rankOf(first)===rankOf(second), `${rankOf(first)} vs ${rankOf(second)}`);

const exc=events.filter(e=>e.method==='Runtime.exceptionThrown').map(e=>e.params.exceptionDetails.text);
const errs=events.filter(e=>e.method==='Log.entryAdded'&&e.params.entry.level==='error').map(e=>e.params.entry.text);
check('no uncaught exceptions', exc.length===0, exc.length+'');
check('no error logs', errs.length===0, errs.length+'');
console.log(fail?`\nFAILURES: ${fail}`:'\nALL CHECKS PASSED');
ws.close(); chrome.kill(); server.close();
try{fs.rmSync(profile,{recursive:true,force:true});}catch{} process.exit(fail?1:0);
