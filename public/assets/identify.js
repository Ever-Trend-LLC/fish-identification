// FishCare AI web fish identifier.
//
// Talks to the shared backend (fishcare-ai-app → supabase/functions/fishcare-api,
// POST /api/identify). Quota, model calls and IP rate limits all live there; this
// page only displays what the API returns. Every value in CONFIG is public: the
// Supabase anon key is RLS-protected and ships in the mobile app too, and a
// Turnstile *site* key is meant for the browser. No secret belongs in this file.

const CONFIG = {
  supabaseUrl: 'https://vpmklwgewhlmrdgvjsvk.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZwbWtsd2dld2hsbXJkZ3Zqc3ZrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQzNDUwNTMsImV4cCI6MjA5OTkyMTA1M30.KzXuG0kNs8RDoenF19yhBClFxBIxBXbrrbNX5ebr8ms',
  // Cloudflare Turnstile site key (public by design; the secret stays in the
  // backend). This page has no build step, so it lives here, not in an env var.
  turnstileSiteKey: '0x4AAAAAAGMlONc9OsFTetiM',
  // Live Supabase backend. Set false to run against the local mock of the
  // API contract (shows a "demo" badge); ?mock=<scenario> forces it for QA.
  backendLive: true,
  // Universal / App Links: must be a different host from this page (www), or
  // iOS Safari will not hand the tap to the app.
  openBase: 'https://fishcareai.com/open',
  appStoreUrl: 'https://apps.apple.com/app/fishcare-ai/id6793299571',
  playUrl: 'https://play.google.com/store/apps/details?id=com.fishcareai.app',
  playLive: false, // keep in step with PLAY_LIVE in www assets/site-compliance.js
};

const API_URL = CONFIG.supabaseUrl + '/functions/v1/fishcare-api/api/identify';
const params = new URLSearchParams(location.search);
// ?mock=<scenario> forces the mock even when the backend is live (QA only).
const MOCK = !CONFIG.backendLive || params.has('mock');
const MOCK_SCENARIO = params.get('mock') || '';
const LAST_RESULT_KEY = 'fc-identify-last';
const QUOTA_KEY = 'fc-identify-quota';
const SIGNUP_PENDING_KEY = 'fc-identify-signup-pending';

const $ = (id) => document.getElementById(id);
const els = {
  dropZone: $('drop-zone'), fileInput: $('file-input'), cameraInput: $('camera-input'),
  previewWrap: $('preview-wrap'), previewImg: $('preview-img'), changeBtn: $('change-btn'),
  spinner: $('spinner'), errorBox: $('error-box'), results: $('results'), resultsBody: $('results-body'),
  quota: $('fc-quota'), demo: $('fc-demo'), modal: $('fc-signup'), form: $('fc-signup-form'),
  formMsg: $('fc-signup-msg'), formTitle: $('fc-signup-title'), formLead: $('fc-signup-lead'),
  modeToggle: $('fc-signup-mode'), submit: $('fc-signup-submit'),
};

// ── Analytics (event names match the app) ──────────────────────────────────
function track(name, data) {
  try {
    if (typeof window.gtag === 'function') {
      window.gtag('event', name, Object.assign({ page_path: location.pathname, transport_type: 'beacon' }, data || {}));
    }
  } catch (e) { /* analytics must never break the page */ }
}

// ── Helpers ────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function readJSON(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } }
function writeJSON(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* private mode */ } }
function platform() {
  const ua = navigator.userAgent;
  if (/iPhone|iPod|iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}
function openAppUrl(speciesId) {
  const qs = '?src=web-identify';
  return speciesId ? `${CONFIG.openBase}/species/${encodeURIComponent(speciesId)}${qs}` : `${CONFIG.openBase}/${qs}`;
}
function storeButtons(placement) {
  const p = platform();
  const ios = `<a class="fc-store" data-store="ios" href="${esc(CONFIG.appStoreUrl)}?ct=${encodeURIComponent('web-' + placement)}&amp;mt=8" rel="noopener">Download on the App Store</a>`;
  const android = CONFIG.playLive
    ? `<a class="fc-store" data-store="android" href="${esc(CONFIG.playUrl)}&amp;referrer=${encodeURIComponent('utm_source=fishcareai.com&utm_medium=web&utm_campaign=' + placement)}" rel="noopener">Get it on Google Play</a>`
    : `<span class="fc-store fc-store-soon">Android app coming soon</span>`;
  if (p === 'ios') return ios;
  if (p === 'android') return android;
  return ios + android;
}

// ── Auth: real Supabase, or a localStorage stand-in while mocking ──────────
// Loaded only for the real backend, so the mock works offline.
const { createClient } = MOCK ? {} : await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
const supabase = MOCK ? null : createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

const MOCK_KEY = 'fc-identify-mock';
function mockState() {
  return readJSON(MOCK_KEY) || { user: null, used: 0, month: new Date().toISOString().slice(0, 7) };
}

const auth = {
  async user() {
    if (MOCK) {
      const u = mockState().user;
      return u ? { id: u.id, isAnonymous: !u.email || !u.confirmed, email: u.email } : null;
    }
    const { data } = await supabase.auth.getSession();
    const u = data.session && data.session.user;
    return u ? { id: u.id, isAnonymous: !!u.is_anonymous, email: u.email || null } : null;
  },
  // Make sure there is a session before the first identification. Anonymous
  // users keep their user_id when they later add an email, so the count carries.
  async ensure() {
    if (MOCK) {
      const s = mockState();
      if (!s.user) { s.user = { id: 'mock-' + Math.random().toString(36).slice(2, 10), email: null, confirmed: false }; writeJSON(MOCK_KEY, s); }
      return 'mock-token';
    }
    const { data } = await supabase.auth.getSession();
    if (data.session) return data.session.access_token;
    const res = await supabase.auth.signInAnonymously();
    if (res.error) throw res.error;
    return res.data.session.access_token;
  },
  // Upgrade the anonymous user in place. Never sign out first: a new user_id
  // would reset the identification count.
  async upgrade(email, password) {
    if (MOCK) {
      const s = mockState();
      s.user = Object.assign(s.user || { id: 'mock-x' }, { email, confirmed: MOCK_SCENARIO !== 'confirm-email' });
      s.used = 0; s.month = new Date().toISOString().slice(0, 7);
      writeJSON(MOCK_KEY, s);
      return { confirmed: s.user.confirmed };
    }
    await this.ensure();
    const { data, error } = await supabase.auth.updateUser(
      { email, password },
      { emailRedirectTo: location.origin + '/identify/?signup=confirmed' },
    );
    if (error) throw error;
    return { confirmed: !!(data.user && data.user.email_confirmed_at) };
  },
  async signIn(email, password) {
    if (MOCK) {
      const s = mockState(); s.user = { id: 'mock-member', email, confirmed: true }; s.used = 0; writeJSON(MOCK_KEY, s);
      return;
    }
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  },
};

// ── Turnstile (anonymous users only) ───────────────────────────────────────
let turnstileLoad = null;
let turnstileWidget = null;
let turnstilePending = null;

function loadTurnstile() {
  if (!turnstileLoad) {
    turnstileLoad = new Promise((resolve, reject) => {
      window.fcTurnstileReady = () => resolve(window.turnstile);
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=fcTurnstileReady';
      s.async = true;
      s.onerror = () => { turnstileLoad = null; reject(new Error('turnstile_load')); };
      document.head.appendChild(s);
    });
  }
  return turnstileLoad;
}

async function turnstileToken() {
  if (MOCK || !CONFIG.turnstileSiteKey) return MOCK ? 'mock-turnstile' : undefined;
  const ts = await loadTurnstile();
  return new Promise((resolve, reject) => {
    let timer = null;
    const arm = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(() => { turnstilePending = null; reject(new Error('turnstile_timeout')); }, ms);
    };
    arm(30000);
    turnstilePending = {
      resolve: (t) => { clearTimeout(timer); turnstilePending = null; resolve(t); },
      reject: (e) => { clearTimeout(timer); turnstilePending = null; reject(e); },
      // Cloudflare wants a click: give the person time to do it.
      interactive: () => { arm(5 * 60 * 1000); els.spinner.textContent = 'Tick the security check above to continue…'; },
    };
    if (turnstileWidget === null) {
      // execution:'execute' + appearance:'interaction-only' keeps it invisible
      // unless Cloudflare wants a human check, in which case it appears in place.
      turnstileWidget = ts.render('#fc-turnstile', {
        sitekey: CONFIG.turnstileSiteKey,
        execution: 'execute',
        appearance: 'interaction-only',
        callback: (t) => turnstilePending && turnstilePending.resolve(t),
        'error-callback': () => { if (turnstilePending) turnstilePending.reject(new Error('turnstile_error')); return true; },
        'before-interactive-callback': () => turnstilePending && turnstilePending.interactive(),
      });
    } else {
      ts.reset(turnstileWidget); // tokens are single-use
    }
    ts.execute(turnstileWidget);
  });
}

// ── Client-side compression: long edge ≤ 1024px, JPEG q≈0.8, ≤ 2 MB base64 ──
const MAX_EDGE = 1024;
const MAX_DATA_URL = 2 * 1024 * 1024;

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
    img.src = url;
  });
}

async function compress(file) {
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { src = await loadImage(file); }
  const w = src.width || src.naturalWidth;
  const h = src.height || src.naturalHeight;
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // transparent PNGs would otherwise turn black in JPEG
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  if (src.close) src.close();
  let q = 0.8;
  let out = canvas.toDataURL('image/jpeg', q);
  while (out.length > MAX_DATA_URL && q > 0.45) { q -= 0.15; out = canvas.toDataURL('image/jpeg', q); }
  if (out.length > MAX_DATA_URL) throw new Error('too_large');
  return out;
}

// ── API call (real or mock) ────────────────────────────────────────────────
async function callApi(photo, isAnonymous) {
  if (MOCK) return mockIdentify();
  const token = await auth.ensure();
  const body = { photo, source: 'web' };
  if (isAnonymous) body.turnstileToken = await turnstileToken();
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, apikey: CONFIG.supabaseAnonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON error page */ }
  return { status: res.status, data };
}

const MOCK_RESULT = {
  isFish: true,
  photoQuality: 'good',
  candidates: [
    { commonName: 'Neon Tetra', scientificName: 'Paracheirodon innesi', confidence: 'High', speciesId: 'neon-tetra' },
    { commonName: 'Cardinal Tetra', scientificName: 'Paracheirodon axelrodi', confidence: 'Moderate', speciesId: 'cardinal-tetra' },
    { commonName: 'Green Neon Tetra', scientificName: 'Paracheirodon simulans', confidence: 'Limited', speciesId: null },
  ],
  careTips: [
    'Keep a group of at least 6 — they school and stress when kept alone.',
    'Soft, slightly acidic water (pH 6.0–7.0) at 22–26 °C.',
    'Add them only to a tank that has been cycled for a month or more.',
  ],
  notes: 'The red stripe stops halfway along the body, which separates a neon from a cardinal tetra.',
};

async function mockIdentify() {
  await new Promise((r) => setTimeout(r, 900));
  const s = mockState();
  const member = s.user && s.user.email && s.user.confirmed;
  const month = new Date().toISOString().slice(0, 7);
  if (member && s.month !== month) { s.used = 0; s.month = month; }
  const tier = MOCK_SCENARIO === 'plus' ? 'plus' : member ? 'member' : 'guest';
  const limit = tier === 'guest' ? 3 : tier === 'member' ? 5 : null;
  const quota = () => ({ tier, used: s.used, limit, period: tier === 'guest' ? 'lifetime' : tier === 'member' ? 'month' : 'day', remaining: limit == null ? null : Math.max(0, limit - s.used) });
  const fail = (status, ai, nextStep) => ({ status, data: { ok: false, identification: null, quota: quota(), ai: { status: ai }, nextStep } });

  if (MOCK_SCENARIO === 'budget') return fail(200, 'budget_paused', 'open_app');
  if (MOCK_SCENARIO === 'timeout') return fail(200, 'timeout');
  if (MOCK_SCENARIO === 'ratelimit') return { status: 429, data: { ok: false, identification: null, ai: { status: 'rate_limited' } } };
  if (MOCK_SCENARIO === 'turnstile') return { status: 403, data: { ok: false, identification: null, ai: { status: 'turnstile_failed' } } };
  if (limit != null && s.used >= limit) return fail(200, 'quota_exhausted', tier === 'guest' ? 'sign_up' : 'open_app');

  s.used += 1; writeJSON(MOCK_KEY, s);
  const identification = MOCK_SCENARIO === 'notfish'
    ? { isFish: false, photoQuality: 'poor', candidates: [], careTips: [], notes: '' }
    : MOCK_RESULT;
  return { status: 200, data: { ok: true, identification, quota: quota(), ai: { status: 'completed', model: 'mock' } } };
}

// ── UI state ───────────────────────────────────────────────────────────────
let lastPhoto = null;
let busy = false;

// The page CSS hides several of these by default, so 'block' (not '') is needed.
function show(el, on) { if (el) el.style.display = on ? 'block' : 'none'; }

function resetView() {
  show(els.dropZone, true); show(els.previewWrap, false); show(els.spinner, false);
  show(els.results, false); show(els.errorBox, false);
  els.fileInput.value = ''; els.cameraInput.value = '';
}

function showError(html, retry) {
  els.errorBox.innerHTML = html + (retry ? ' <button type="button" class="fc-link-btn" id="fc-retry">Try again</button>' : '');
  show(els.errorBox, true);
  const btn = document.getElementById('fc-retry');
  if (btn) btn.addEventListener('click', () => { show(els.errorBox, false); identify(lastPhoto); });
}

function renderQuota(q) {
  if (!q) { els.quota.textContent = ''; show(els.quota, false); return; }
  let text;
  if (q.tier === 'plus' || q.remaining == null) text = 'Unlimited identifications with FishCare AI Plus';
  else if (q.tier === 'guest') text = `${q.remaining} free identification${q.remaining === 1 ? '' : 's'} left — no sign-up needed`;
  else text = `${q.remaining} of ${q.limit} free identifications left this ${q.period === 'day' ? 'day' : 'month'} · shared with the app`;
  els.quota.textContent = text;
  show(els.quota, true);
}

function confClass(c) { return c === 'High' ? 'acc-badge' : c === 'Moderate' ? 'acc-badge mid' : 'acc-badge low'; }

function saveButton(speciesId) {
  return `<a class="upload-btn fc-open-app" href="${esc(openAppUrl(speciesId))}" data-species="${esc(speciesId || '')}">Save this fish in the app</a>`;
}

function renderResult(ident, quota) {
  const tier = quota ? quota.tier : 'guest';
  if (!ident.isFish || !ident.candidates || !ident.candidates.length) {
    els.resultsBody.innerHTML = '<div class="no-fish">🔍 We couldn&rsquo;t spot a fish in this photo. Try a clear, side-on shot with the fish filling more of the frame.</div>';
    show(els.results, true);
    return;
  }
  const [top, ...rest] = ident.candidates;
  const quality = ident.photoQuality === 'poor'
    ? '<p class="fc-quality">Photo quality is poor, so treat this as a guess — a sharper side-on photo will give a firmer answer.</p>'
    : ident.photoQuality === 'usable' ? '<p class="fc-quality">Photo quality is usable but not ideal; a sharper side-on shot will firm this up.</p>' : '';
  const tips = (ident.careTips || []).length
    ? `<h3 class="fc-sub">Care tips</h3><ul class="fc-tips">${ident.careTips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '';
  const notes = ident.notes ? `<p class="species-desc fc-notes">${esc(ident.notes)}</p>` : '';

  let more = '';
  if (rest.length && tier === 'guest') {
    more = `<div class="fc-locked">
      <strong>${rest.length} more possible match${rest.length === 1 ? '' : 'es'} and the full care card</strong>
      <p>Create a free account to see every candidate and get more free identifications each month.</p>
      <button type="button" class="upload-btn fc-signup-open">Create free account</button>
    </div>`;
  } else if (rest.length) {
    more = `<h3 class="fc-sub">Other possible matches</h3>` + rest.map((c) => `
      <div class="species-item fc-alt">
        <div class="species-info">
          <div class="species-name">${esc(c.commonName)}</div>
          <div class="species-sci">${esc(c.scientificName)}</div>
          <div class="species-meta"><span class="${confClass(c.confidence)}">${esc(c.confidence)} confidence</span></div>
        </div>
        <a class="fc-link-btn fc-open-app" href="${esc(openAppUrl(c.speciesId))}" data-species="${esc(c.speciesId || '')}">Save</a>
      </div>`).join('');
  }

  els.resultsBody.innerHTML = `
    <div class="fish-card">
      <div class="species-list">
        <div class="fc-top">
          <div class="species-name fc-top-name">${esc(top.commonName)}</div>
          <div class="species-sci">${esc(top.scientificName)}</div>
          <div class="species-meta"><span class="${confClass(top.confidence)}">${esc(top.confidence)} confidence</span></div>
          ${quality}${tips}${notes}
          <div class="fc-actions">${saveButton(top.speciesId)}</div>
          <p class="fc-small">Opens the FishCare AI app if it is installed; otherwise you will see the species page and app download links.${tier !== 'guest' ? ' The full care card is in the app.' : ''}</p>
        </div>
        ${more}
      </div>
    </div>`;
  show(els.results, true);
}

function renderExhausted(tier, nextStep) {
  track('identify_quota_exhausted', { tier });
  if (nextStep === 'sign_up' || tier === 'guest') {
    openSignup('quota');
    showError('You have used your free identifications. <button type="button" class="fc-link-btn fc-signup-open">Create a free account</button> to get more every month.');
    return;
  }
  els.resultsBody.innerHTML = `<div class="fc-panel">
    <strong>You&rsquo;ve used this month&rsquo;s free identifications</strong>
    <p>Keep identifying in the FishCare AI app — your account and count carry over — or go unlimited with FishCare AI Plus.</p>
    <div class="fc-actions"><a class="upload-btn fc-open-app" href="${esc(openAppUrl(null))}" data-species="">Open the app</a>${storeButtons('identify-quota')}</div>
  </div>`;
  show(els.results, true);
}

function renderAppOnly(message) {
  els.resultsBody.innerHTML = `<div class="fc-panel">
    <strong>${message}</strong>
    <div class="fc-actions"><a class="upload-btn fc-open-app" href="${esc(openAppUrl(null))}" data-species="">Continue in the app</a>${storeButtons('identify-paused')}</div>
  </div>`;
  show(els.results, true);
}

// ── Main flow ──────────────────────────────────────────────────────────────
async function handleFile(file) {
  if (!file || busy) return;
  if (file.type && !file.type.startsWith('image/')) return showError('⚠️ Please choose an image file.');
  show(els.errorBox, false); show(els.results, false);
  let photo;
  try {
    photo = await compress(file);
  } catch (e) {
    return showError(e.message === 'too_large'
      ? '⚠️ This photo is too large to send even after compressing. Try a smaller one.'
      : '⚠️ We couldn&rsquo;t read this image. Try a JPEG or PNG, or take a new photo.');
  }
  lastPhoto = photo;
  els.previewImg.src = photo;
  show(els.dropZone, false); show(els.previewWrap, true);
  identify(photo);
}

async function identify(photo, retried) {
  if (!photo || busy) return;
  busy = true;
  els.spinner.textContent = 'Identifying your fish…';
  show(els.spinner, true); show(els.errorBox, false); show(els.results, false);
  if (!retried) track('identify_start', { source: 'web' });
  let res;
  try {
    await auth.ensure();
    const user = await auth.user();
    res = await callApi(photo, !user || user.isAnonymous);
  } catch (e) {
    busy = false; show(els.spinner, false);
    if (String(e && e.message).startsWith('turnstile')) return showError('⚠️ We couldn&rsquo;t complete the quick security check. Please try again.', true);
    return showError('⚠️ Identification is temporarily unavailable. Please try again.', true);
  }
  busy = false; show(els.spinner, false);

  const data = res.data || {};
  const ai = (data.ai && data.ai.status) || '';
  if (data.quota) { renderQuota(data.quota); const u = await auth.user(); if (u) writeJSON(QUOTA_KEY, { uid: u.id, quota: data.quota }); }
  const tier = (data.quota && data.quota.tier) || 'guest';

  if (res.status === 403 || ai === 'turnstile_failed') {
    if (!retried && !MOCK) return identify(photo, true); // fresh token, one retry
    return showError('⚠️ The security check failed. Please try again.', true);
  }
  if (res.status === 429 || ai === 'rate_limited') {
    return renderAppOnly('Too many identifications from this network right now. Try again later, or continue in the app.');
  }
  if (data.identification) {
    const ident = data.identification;
    const top = ident.candidates && ident.candidates[0];
    track('identify_result', { confidence: top ? top.confidence : 'none', is_fish: !!ident.isFish, tier });
    const u = await auth.user();
    if (u) writeJSON(LAST_RESULT_KEY, { uid: u.id, identification: ident, at: Date.now() });
    return renderResult(ident, data.quota);
  }
  if (ai === 'quota_exhausted') return renderExhausted(tier, data.nextStep);
  if (ai === 'budget_paused') return renderAppOnly('Today&rsquo;s web identifications are all used up. Continue in the FishCare AI app.');
  return showError('⚠️ Identification is temporarily unavailable. Please try again.', true);
}

// ── Sign-up modal ──────────────────────────────────────────────────────────
let signupMode = 'signup';

function setSignupMode(mode) {
  signupMode = mode;
  const up = mode === 'signup';
  els.formTitle.textContent = up ? 'Create your free FishCare AI account' : 'Sign in to FishCare AI';
  els.formLead.textContent = up
    ? 'Keep your identifications, see every match and get more free identifications each month. The same account works in the app.'
    : 'Use the email and password from the FishCare AI app.';
  els.submit.textContent = up ? 'Create account' : 'Sign in';
  els.modeToggle.textContent = up ? 'Already have an account? Sign in' : 'New here? Create a free account';
  els.form.password.autocomplete = up ? 'new-password' : 'current-password';
  els.formMsg.textContent = '';
}

function openSignup(reason) {
  if (reason !== 'quota') track('identify_signup_click', { reason: reason || 'result' });
  setSignupMode('signup');
  if (typeof els.modal.showModal === 'function') els.modal.showModal(); else els.modal.setAttribute('open', '');
}

async function submitSignup(ev) {
  ev.preventDefault();
  const email = els.form.email.value.trim();
  const password = els.form.password.value;
  if (password.length < 8) { els.formMsg.textContent = 'Use at least 8 characters for your password.'; return; }
  els.submit.disabled = true; els.formMsg.textContent = '';
  try {
    if (signupMode === 'signin') {
      await auth.signIn(email, password);
      els.modal.close();
      afterAccountChange();
      return;
    }
    const { confirmed } = await auth.upgrade(email, password);
    if (confirmed) {
      track('identify_signup_complete', { method: 'email' });
      els.modal.close();
      afterAccountChange();
    } else {
      writeJSON(SIGNUP_PENDING_KEY, { at: Date.now() });
      els.formMsg.innerHTML = `Check <strong>${esc(email)}</strong> and tap the confirmation link. Your identifications carry over.`;
    }
  } catch (e) {
    const msg = String((e && e.message) || '');
    els.formMsg.textContent = /registered|already/i.test(msg)
      ? 'That email already has an account — sign in instead.'
      : (msg || 'Something went wrong. Please try again.');
    if (/registered|already/i.test(msg)) setSignupMode('signin');
  } finally {
    els.submit.disabled = false;
  }
}

// After sign-up/sign-in, show the saved result unlocked and the new quota.
async function afterAccountChange() {
  const u = await auth.user();
  const last = readJSON(LAST_RESULT_KEY);
  show(els.errorBox, false);
  if (u && !u.isAnonymous) {
    const q = readJSON(QUOTA_KEY);
    renderQuota(q && q.uid === u.id && q.quota.tier !== 'guest' ? q.quota : null);
    if (last && last.identification) renderResult(last.identification, { tier: 'member' });
  }
}

// ── Wiring ─────────────────────────────────────────────────────────────────
async function init() {
  if (MOCK) show(els.demo, true);
  ['dragenter', 'dragover'].forEach((e) => els.dropZone.addEventListener(e, (ev) => { ev.preventDefault(); els.dropZone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((e) => els.dropZone.addEventListener(e, (ev) => { ev.preventDefault(); els.dropZone.classList.remove('drag'); }));
  els.dropZone.addEventListener('drop', (ev) => handleFile(ev.dataTransfer.files[0]));
  els.fileInput.addEventListener('change', () => handleFile(els.fileInput.files[0]));
  els.cameraInput.addEventListener('change', () => handleFile(els.cameraInput.files[0]));
  els.changeBtn.addEventListener('click', resetView);
  els.form.addEventListener('submit', submitSignup);
  els.modeToggle.addEventListener('click', () => setSignupMode(signupMode === 'signup' ? 'signin' : 'signup'));
  document.getElementById('fc-signup-close').addEventListener('click', () => els.modal.close());

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest && ev.target.closest('.fc-signup-open, .fc-open-app, .fc-store');
    if (!t) return;
    if (t.classList.contains('fc-signup-open')) { ev.preventDefault(); openSignup('result'); }
    else if (t.classList.contains('fc-open-app')) track('identify_open_app_click', { species_id: t.dataset.species || '' });
    else if (t.dataset.store) track('identify_store_click', { store: t.dataset.store });
  });

  // Restore the remaining count for a returning visitor (no API call).
  const u = await auth.user().catch(() => null);
  const q = readJSON(QUOTA_KEY);
  if (u && q && q.uid === u.id) renderQuota(q.quota);

  // Back from the confirmation email: the anonymous user is now permanent.
  const pending = readJSON(SIGNUP_PENDING_KEY);
  if (pending && u && !u.isAnonymous) {
    localStorage.removeItem(SIGNUP_PENDING_KEY);
    track('identify_signup_complete', { method: 'email' });
    afterAccountChange();
  }
}

init();

// QA hook: lets the mock be reset from the console. Not present in live mode.
if (MOCK) window.fcIdentifyMockReset = () => { localStorage.removeItem(MOCK_KEY); localStorage.removeItem(QUOTA_KEY); localStorage.removeItem(LAST_RESULT_KEY); location.reload(); };
