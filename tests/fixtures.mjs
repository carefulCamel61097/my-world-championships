/* Record / replay of the BWF API for the end-to-end suites.
 *
 * Why this exists: BWF's Cloudflare blocks headless Chrome, so every suite has
 * to drive a real windowed browser against the live API, and the app politely
 * spaces its own requests 320ms apart. Between latency and that gap, a suite
 * spent ~45 seconds loading before it could assert anything — about 14 minutes
 * of pure waiting across a full regression, and the answers changed under us as
 * the tournament progressed.
 *
 * Interception is done with CDP's Fetch domain rather than by pointing the app
 * at a local proxy, so the application needs no test-only code path and what is
 * exercised is exactly what ships.
 *
 *   record:  Fetch pauses at the *response* stage, the body is saved, and the
 *            request continues to the network as normal.
 *   replay:  Fetch pauses at the *request* stage and is fulfilled from disk.
 *            Anything with no fixture falls through to the live API and is
 *            reported, so a gap shows up as a slow test rather than a silent
 *            wrong answer.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIX_DIR = path.join(HERE, 'fixtures');

const API_HOST = 'extranet-lv.bwfbadminton.com';
const keyFor = url => crypto.createHash('sha1').update(url).digest('hex').slice(0, 20);
const fileFor = url => path.join(FIX_DIR, keyFor(url) + '.json');

export function fixtureCount() {
  try { return fs.readdirSync(FIX_DIR).filter(f => f.endsWith('.json')).length; }
  catch { return 0; }
}

/**
 * Wire fixture handling into a suite.
 *
 * The suite must forward every CDP event to the returned `handle`, and pass its
 * own `send(method, params, sessionId)`.
 *
 * @param {object}   [opts]
 * @param {function} [opts.mutate]  (url, bodyText, nth) => bodyText | null.
 *   Called on every replayed response, `nth` counting from 1 per URL. Returning
 *   null leaves the fixture alone. This is how the live-refresh suite makes the
 *   second fetch of a day differ from the first — otherwise a replayed API can
 *   only ever describe a tournament frozen at one instant.
 */
export async function installFixtures(send, sessionId, opts = {}) {
  // FIXTURES=record re-runs any suite against the live API and tops up the set
  // with whatever that suite asks for and the recorder did not think of.
  const record = opts.record !== undefined ? !!opts.record : process.env.FIXTURES === 'record';
  const quiet = !!opts.quiet;
  if (record) fs.mkdirSync(FIX_DIR, { recursive: true });

  const stats = { served: 0, recorded: 0, missed: 0, misses: new Set() };
  const seen = new Map();          // url -> how many times replayed

  await send('Fetch.enable', {
    patterns: [{ urlPattern: `*${API_HOST}*`, requestStage: record ? 'Response' : 'Request' }],
  }, sessionId);

  const handle = msg => {
    if (msg.method !== 'Fetch.requestPaused') return;
    const p = msg.params;
    const rid = p.requestId;
    const url = p.request.url;

    if (record) {
      // Response stage: capture the body, then let it through untouched.
      send('Fetch.getResponseBody', { requestId: rid }, sessionId).then(res => {
        if (res && typeof res.body === 'string') {
          fs.writeFileSync(fileFor(url), JSON.stringify({
            url, status: p.responseStatusCode || 200,
            base64Encoded: !!res.base64Encoded, body: res.body,
          }));
          stats.recorded++;
        }
      }).catch(() => {}).finally(() => {
        send('Fetch.continueRequest', { requestId: rid }, sessionId).catch(() => {});
      });
      return;
    }

    // Replay.
    let fx = null;
    try { fx = JSON.parse(fs.readFileSync(fileFor(url), 'utf8')); } catch {}
    if (!fx) {
      stats.missed++;
      stats.misses.add(url.replace(/^https?:\/\/[^/]+\/api\//, ''));
      if (!quiet) console.log('  [fixture MISS -> live] ' + url.slice(0, 120));
      send('Fetch.continueRequest', { requestId: rid }, sessionId).catch(() => {});
      return;
    }
    stats.served++;
    const nth = (seen.get(url) || 0) + 1;
    seen.set(url, nth);
    if (opts.mutate) {
      const text = fx.base64Encoded ? Buffer.from(fx.body, 'base64').toString('utf8') : fx.body;
      const next = opts.mutate(url, text, nth);
      if (next != null) fx = { status: fx.status, base64Encoded: false, body: next };
    }
    send('Fetch.fulfillRequest', {
      requestId: rid,
      responseCode: fx.status || 200,
      responseHeaders: [
        { name: 'content-type', value: 'application/json' },
        // The page is on localhost; the real API reflects the origin, so the
        // replayed response has to allow it too or the browser blocks it.
        { name: 'access-control-allow-origin', value: '*' },
        { name: 'cache-control', value: 'no-store' },
      ],
      body: fx.base64Encoded ? fx.body : Buffer.from(fx.body, 'utf8').toString('base64'),
    }, sessionId).catch(() => {});
  };

  return { handle, stats, record };
}

/** One-line summary for the end of a suite. */
export function fixtureReport(fx) {
  if (!fx) return '';
  if (fx.record) return `fixtures recorded: ${fx.stats.recorded}`;
  const miss = fx.stats.missed
    ? `, ${fx.stats.missed} live (${[...fx.stats.misses].slice(0, 3).join(', ')})` : '';
  return `fixtures served: ${fx.stats.served}${miss}`;
}
