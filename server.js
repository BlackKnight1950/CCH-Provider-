'use strict';
/*
 * CCH Provider Finder — server
 *
 * Reads two Smartsheet sheets through the Smartsheet API, joins them, and serves
 * the search page plus a small JSON endpoint. The Smartsheet token stays on the
 * server (Render environment variable) and is never sent to the browser.
 *
 * Auto-update: every request checks (at most once per REFRESH_SECONDS) whether
 * either sheet's version changed. If so, both sheets are re-read. The browser
 * polls every minute, so edits in Smartsheet reach agents without a redeploy.
 */

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');

// ─── Configuration (all overridable with environment variables) ──────────────
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.SMARTSHEET_API_KEY;
const API_BASE = (process.env.SMARTSHEET_API_BASE || 'https://api.smartsheet.com/2.0').replace(/\/$/, '');
const PROVIDER_SHEET_ID = process.env.PROVIDER_SHEET_ID || '4254079686758276'; // "Provider Lookup" sheet
const LOCATION_SHEET_ID = process.env.LOCATION_SHEET_ID || '4255312342372228'; // "By Location" sheet
const CHECK_MS = (Number(process.env.REFRESH_SECONDS) || 30) * 1000;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const PAGE_SIZE = 2000;

// ─── Small helpers ────────────────────────────────────────────────────────────
const clean = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
const keyOf = (v) => clean(v).toLowerCase();
const byText = (a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function splitLanguages(v) {
  const seen = new Set();
  const out = [];
  clean(v).split(/[,;/]+/).forEach((x) => {
    const t = x.trim();
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
  });
  return out;
}
function mergeLanguages(a, b) {
  const seen = new Set(a.map((x) => x.toLowerCase()));
  b.forEach((x) => { if (!seen.has(x.toLowerCase())) { seen.add(x.toLowerCase()); a.push(x); } });
  return a;
}

// Display wording. Blank (or the older "Not listed – verify" placeholder) stays blank.
function acceptText(v) {
  const s = clean(v);
  if (!s || /^not listed/i.test(s)) return '';
  if (/^new\s*&\s*existing/i.test(s)) return 'Accepts New & Existing patients';
  if (/^accepting new/i.test(s)) return 'Accepts new patients';
  if (/^exist/i.test(s)) return 'Existing patients only';
  if (/^closed/i.test(s)) return 'Not accepting new patients';
  return s;
}
function genderText(v) {
  const s = clean(v);
  if (!s || /^not listed/i.test(s)) return '';
  if (/^both/i.test(s)) return 'Accepts Male and Female patients';
  if (/^male/i.test(s)) return 'Accepts Male patients';
  if (/^female/i.test(s)) return 'Accepts Female patients';
  return s;
}

// ─── Smartsheet API ───────────────────────────────────────────────────────────
async function ssGet(urlPath) {
  if (!TOKEN) throw new Error('SMARTSHEET_API_KEY is not set on the server.');
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30000);
    try {
      const r = await fetch(API_BASE + urlPath, {
        headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'application/json' },
        signal: ctl.signal,
      });
      const text = await r.text();
      if (r.ok) return JSON.parse(text);
      let msg = 'HTTP ' + r.status;
      try { const j = JSON.parse(text); if (j.message) msg += ' – ' + j.message; } catch (e) { /* not JSON */ }
      lastErr = new Error('Smartsheet request failed (' + msg + ')');
      lastErr.status = r.status;
      if (r.status !== 429 && r.status < 500) break; // 401/403/404: retrying will not help
    } catch (e) {
      lastErr = new Error('Could not reach Smartsheet (' + (e.name === 'AbortError' ? 'timeout' : e.message) + ')');
    } finally {
      clearTimeout(timer);
    }
    await sleep(1000 * Math.pow(2, attempt));
  }
  throw lastErr;
}

async function fetchSheet(id) {
  let page = 1, rows = [], first = null;
  for (;;) {
    const s = await ssGet('/sheets/' + id + '?pageSize=' + PAGE_SIZE + '&page=' + page);
    if (!first) first = s;
    const got = s.rows || [];
    rows = rows.concat(got);
    const total = Number(s.totalRowCount);
    if (got.length < PAGE_SIZE || (total && rows.length >= total)) break;
    page++;
  }
  return { id, name: first.name, version: first.version, modifiedAt: first.modifiedAt, columns: first.columns || [], rows };
}

// ─── Column mapping (by title, case-insensitive, so renames and new columns are tolerated) ───
function findCol(columns, tests) {
  for (const test of tests) {
    const c = columns.find((col) => test(clean(col.title).toLowerCase()));
    if (c) return c;
  }
  return null;
}
function mapColumns(sheet, kind) {
  const cols = sheet.columns;
  const primary = cols.find((c) => c.primary) || cols[0];
  const m = {
    name: findCol(cols, [(t) => t === 'provider name', (t) => t.includes('provider name'), (t) => t.includes('provider')]) || (kind === 'providers' ? primary : null),
    spec: findCol(cols, [(t) => t.includes('specialty'), (t) => t.includes('service')]),
    lang: findCol(cols, [(t) => t.includes('language')]),
    accept: findCol(cols, [(t) => t.includes('new patient'), (t) => t.includes('accepting')]),
    gender: findCol(cols, [(t) => t.includes('gender')]),
  };
  if (kind === 'providers') {
    m.locs = findCol(cols, [(t) => t.includes('location') || t.includes('sites where')]);
  } else {
    m.loc = findCol(cols, [(t) => t === 'cch location', (t) => t.includes('location')]) || primary;
  }
  return m;
}
function rowReader(map) {
  return (row) => {
    const byId = {};
    (row.cells || []).forEach((c) => { byId[c.columnId] = c.value !== undefined && c.value !== null ? c.value : c.displayValue; });
    const get = (col) => (col ? clean(byId[col.id]) : '');
    const out = {};
    Object.keys(map).forEach((k) => { out[k] = get(map[k]); });
    return out;
  };
}

// ─── Join the two sheets into what the page needs ─────────────────────────────
function build(provSheet, locSheet) {
  const pMap = mapColumns(provSheet, 'providers');
  const lMap = mapColumns(locSheet, 'locations');
  const missing = [];
  if (!pMap.name) missing.push('Provider Lookup sheet: Provider Name column');
  if (!lMap.name) missing.push('By Location sheet: Provider Name column');
  if (!lMap.loc) missing.push('By Location sheet: CCH Location column');
  if (missing.length) throw new Error('Required columns not found – ' + missing.join('; '));

  const readP = rowReader(pMap);
  const readL = rowReader(lMap);
  const warnings = { rowsWithoutName: 0, siteRowsWithoutLocation: 0, duplicateSiteRows: 0, providersOnlyInLocationSheet: [], providersWithoutSiteRows: [], providersWithoutSpecialty: [] };

  // Providers from the Provider Lookup sheet
  const providers = new Map();
  provSheet.rows.forEach((row) => {
    const r = readP(row);
    if (!r.name) { warnings.rowsWithoutName++; return; }
    const k = keyOf(r.name);
    let p = providers.get(k);
    if (!p) { p = { n: r.name, s: '', langs: [], locsText: '', sites: new Map() }; providers.set(k, p); }
    if (!p.s) p.s = r.spec;
    mergeLanguages(p.langs, splitLanguages(r.lang));
    if (!p.locsText) p.locsText = r.locs || '';
  });

  // Site rows from the By Location sheet
  const siteIndex = new Map();
  const siteRows = [];
  locSheet.rows.forEach((row) => {
    const r = readL(row);
    if (!r.name) { if (r.loc || r.spec) warnings.rowsWithoutName++; return; }
    if (!r.loc) { warnings.siteRowsWithoutLocation++; return; }
    const sk = keyOf(r.name) + '||' + keyOf(r.loc);
    let s = siteIndex.get(sk);
    if (s) {
      warnings.duplicateSiteRows++;
      if (!s.s) s.s = r.spec;
      if (!s.a) s.a = acceptText(r.accept);
      if (!s.g) s.g = genderText(r.gender);
      mergeLanguages(s.langs, splitLanguages(r.lang));
      return;
    }
    s = { loc: r.loc, n: r.name, s: r.spec, langs: splitLanguages(r.lang), a: acceptText(r.accept), g: genderText(r.gender) };
    siteIndex.set(sk, s);
    siteRows.push(s);
  });

  // Attach sites to providers (creating a provider if it only exists in the By Location sheet)
  siteRows.forEach((s) => {
    const k = keyOf(s.n);
    let p = providers.get(k);
    if (!p) {
      p = { n: s.n, s: '', langs: [], locsText: '', sites: new Map(), fromLocationSheetOnly: true };
      providers.set(k, p);
      warnings.providersOnlyInLocationSheet.push(s.n);
    }
    if (!p.s) p.s = s.s;
    if (p.fromLocationSheetOnly) mergeLanguages(p.langs, s.langs);
    p.sites.set(keyOf(s.loc), [s.loc, s.a, s.g]);
  });

  const outProviders = [];
  providers.forEach((p) => {
    if (!p.sites.size && p.locsText) {
      // Fallback: no rows in the By Location sheet, so use the location list typed on the Provider Lookup sheet
      p.locsText.split(';').map(clean).filter(Boolean).forEach((loc) => p.sites.set(keyOf(loc), [loc, '', '']));
      if (p.sites.size) warnings.providersWithoutSiteRows.push(p.n);
    }
    if (!p.s) warnings.providersWithoutSpecialty.push(p.n);
    const t = Array.from(p.sites.values()).sort((a, b) => byText(a[0], b[0]));
    outProviders.push({ n: p.n, s: p.s, l: p.langs.join(', '), t });
  });
  outProviders.sort((a, b) => byText(a.n, b.n));
  siteRows.sort((a, b) => byText(a.loc, b.loc) || byText(a.n, b.n));

  const modified = [provSheet.modifiedAt, locSheet.modifiedAt].filter(Boolean).sort().pop() || null;
  const locations = new Set(siteRows.map((s) => s.loc)).size;
  return {
    payload: {
      version: provSheet.version + '.' + locSheet.version,
      modifiedAt: modified,
      providers: outProviders,
      sites: siteRows.map((s) => [s.loc, s.n, s.s, s.langs.join(', '), s.a, s.g]),
    },
    status: {
      sheets: {
        providerLookup: { id: provSheet.id, name: provSheet.name, version: provSheet.version, rows: provSheet.rows.length, columnsFound: Object.fromEntries(Object.entries(pMap).map(([k, c]) => [k, c ? c.title : null])) },
        byLocation: { id: locSheet.id, name: locSheet.name, version: locSheet.version, rows: locSheet.rows.length, columnsFound: Object.fromEntries(Object.entries(lMap).map(([k, c]) => [k, c ? c.title : null])) },
      },
      counts: { providers: outProviders.length, locations, listings: siteRows.length },
      dataChecks: {
        rowsWithoutProviderName: warnings.rowsWithoutName,
        siteRowsWithoutLocation: warnings.siteRowsWithoutLocation,
        duplicateSiteRowsMerged: warnings.duplicateSiteRows,
        providersOnlyInByLocationSheet: warnings.providersOnlyInLocationSheet.length,
        providersWithoutRowsInByLocationSheet: warnings.providersWithoutSiteRows.length,
        providersWithoutSpecialty: warnings.providersWithoutSpecialty.length,
        examples: {
          providersOnlyInByLocationSheet: warnings.providersOnlyInLocationSheet.slice(0, 15),
          providersWithoutRowsInByLocationSheet: warnings.providersWithoutSiteRows.slice(0, 15),
          providersWithoutSpecialty: warnings.providersWithoutSpecialty.slice(0, 15),
        },
      },
    },
  };
}

// ─── Cache + version check ────────────────────────────────────────────────────
let cache = null;      // { payload, status, versions:{p,l}, checkedAt, loadedAt, error }
let inflight = null;

function ensureFresh() {
  const now = Date.now();
  if (cache && now - cache.checkedAt < CHECK_MS) return Promise.resolve(cache);
  if (inflight) return inflight;
  const run = (async () => {
    try {
      if (cache) {
        const [vp, vl] = await Promise.all([
          ssGet('/sheets/' + PROVIDER_SHEET_ID + '/version'),
          ssGet('/sheets/' + LOCATION_SHEET_ID + '/version'),
        ]);
        if (vp.version === cache.versions.p && vl.version === cache.versions.l) {
          cache.checkedAt = Date.now();
          cache.error = null;
          return cache;
        }
      }
      const [a, b] = await Promise.all([fetchSheet(PROVIDER_SHEET_ID), fetchSheet(LOCATION_SHEET_ID)]);
      const built = build(a, b);
      cache = {
        payload: built.payload,
        status: built.status,
        versions: { p: a.version, l: b.version },
        checkedAt: Date.now(),
        loadedAt: new Date().toISOString(),
        error: null,
      };
      console.log('[refresh] loaded', built.status.counts, 'versions', cache.versions);
      return cache;
    } catch (e) {
      console.error('[refresh] failed:', e.message);
      if (cache) {
        cache.error = e.message;
        cache.checkedAt = Date.now() - CHECK_MS + 10000; // try again in ~10 seconds
        return cache;
      }
      throw e;
    }
  })();
  inflight = run;
  run.then(() => { if (inflight === run) inflight = null; }, () => { if (inflight === run) inflight = null; });
  return run;
}

// ─── App ──────────────────────────────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// Render health check: no auth, no data
app.get('/healthz', (req, res) => res.type('text').send('ok'));

// Optional password (HTTP Basic). Set APP_PASSWORD on Render to turn it on; any user name works.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
app.use((req, res, next) => {
  if (!APP_PASSWORD) return next();
  const h = req.headers.authorization || '';
  if (h.startsWith('Basic ')) {
    const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
    const pass = decoded.slice(decoded.indexOf(':') + 1);
    if (safeEqual(pass, APP_PASSWORD)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="CCH Provider Finder", charset="UTF-8"');
  res.status(401).send('Password required.');
});

app.use((req, res, next) => {
  res.set({
    'X-Robots-Tag': 'noindex, nofollow',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'",
  });
  next();
});
app.use(compression());

app.get('/robots.txt', (req, res) => res.type('text').send('User-agent: *\nDisallow: /\n'));

app.get('/api/data', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const c = await ensureFresh();
    const stale = !!c.error;
    if (req.query.v && String(req.query.v) === c.payload.version) {
      return res.json({ unchanged: true, version: c.payload.version, stale });
    }
    res.json(Object.assign({ stale }, c.payload));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Diagnostics for whoever maintains the sheets (behind the same password when one is set)
app.get('/api/status', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const c = await ensureFresh();
    res.json({ ok: !c.error, lastLoadedAt: c.loadedAt, lastError: c.error, refreshEverySeconds: CHECK_MS / 1000, passwordProtected: !!APP_PASSWORD, ...c.status });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message, smartsheetKeySet: !!TOKEN });
  }
});

app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  setHeaders: (res, file) => {
    if (file.endsWith('.woff2')) res.set('Cache-Control', 'public, max-age=31536000, immutable');
    else res.set('Cache-Control', 'no-cache');
  },
}));

app.listen(PORT, () => {
  console.log('=== CCH Provider Finder on port ' + PORT + ' ===');
  console.log('=== SMARTSHEET_API_KEY: ' + (TOKEN ? 'SET ✓' : 'NOT SET ✗') + ' ===');
  console.log('=== Sheets: providers ' + PROVIDER_SHEET_ID + ', locations ' + LOCATION_SHEET_ID + ' ===');
  console.log('=== Password protection: ' + (APP_PASSWORD ? 'ON' : 'OFF') + ' ===');
  if (TOKEN) ensureFresh().catch(() => {}); // warm the cache at start-up
});
