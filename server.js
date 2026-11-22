const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
// ── HTTP utils ────────────────────────────────────────────────────────────────

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendFile(res, filePath, contentType) {
  const data = fs.readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': data.length });
  res.end(data);
}

// ── Server ────────────────────────────────────────────────────────────────────

// ── Canonical location ────────────────────────────────────────────────────────
// The app lives at https://www.fishcareai.com/identify/ — the www nginx proxies
// /identify/* here and marks the request with X-FishCare-Proxy. Requests that
// reach this server on any other public host (identify.fishcareai.com, the raw
// anysites.app host) are the old locations and 301 to the canonical path so the
// content exists at exactly one URL. Localhost is left alone for development.
const CANONICAL_ORIGIN = 'https://www.fishcareai.com';
const PATH_PREFIX = '/identify';

function isProxiedOrLocal(req) {
  if (req.headers['x-fishcare-proxy']) return true;
  const host = (req.headers.host || '').split(':')[0];
  return host === 'localhost' || host === '127.0.0.1';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // HEAD must be served exactly like GET (Node suppresses the body itself).
  // Without this, crawlers and link checkers that probe with HEAD see a 404.
  const isRead = req.method === 'GET' || req.method === 'HEAD';

  // Strip the /identify prefix the www proxy forwards, so routes below stay rooted.
  if (url.pathname === PATH_PREFIX) {
    res.writeHead(301, { Location: PATH_PREFIX + '/' + url.search }); res.end(); return;
  }
  if (url.pathname.startsWith(PATH_PREFIX + '/')) {
    url.pathname = url.pathname.slice(PATH_PREFIX.length) || '/';
  }

  // Old hosts → canonical www path (GET/HEAD only; the API is never linked from old hosts).
  if (isRead && !isProxiedOrLocal(req)) {
    res.writeHead(301, { Location: CANONICAL_ORIGIN + PATH_PREFIX + url.pathname + url.search });
    res.end();
    return;
  }

  // The old Fishial upload endpoint is retired: identification now runs on the
  // shared Supabase backend (fishcare-api /api/identify), called from the page.
  if (url.pathname === '/api/identify' || url.pathname.startsWith('/api/identify/')) {
    return sendJSON(res, 410, { error: 'This endpoint has been retired.' });
  }

  // GET/HEAD /viewer  – original 3D embedding viewer
  if (isRead && url.pathname === '/viewer') {
    sendFile(res, path.join(__dirname, 'static', 'index.html'), 'text/html; charset=utf-8');
    return;
  }

  // GET/HEAD /* – serve static files from public/ (with path-traversal guard)
  if (isRead) {
    const publicDir = path.join(__dirname, 'public');
    const raw = decodeURIComponent(url.pathname);
    const slug = path.normalize(raw).replace(/^[/\\]+/, '') || 'index.html';
    const candidates = [
      path.join(publicDir, slug),
      path.join(publicDir, slug + '.html'),
      path.join(publicDir, slug, 'index.html'),
    ];
    for (const fp of candidates) {
      if (!fp.startsWith(publicDir + path.sep) && fp !== publicDir) continue; // traversal guard
      if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
        const ext = path.extname(fp).toLowerCase();
        const ct = ext === '.html' ? 'text/html; charset=utf-8'
                 : ext === '.css'  ? 'text/css'
                 : ext === '.js'   ? 'application/javascript'
                 : ext === '.xml'  ? 'application/xml; charset=utf-8'
                 : ext === '.txt'  ? 'text/plain; charset=utf-8'
                 : ext === '.png'  ? 'image/png'
                 : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
                 : 'application/octet-stream';
        sendFile(res, fp, ct);
        return;
      }
    }
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`Fish ID server on port ${PORT}`));
