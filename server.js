// Runs hidden behind the app window: serves the interface, saves the board,
// and exits on its own once the window is closed.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, 'public');
const HOME = process.env.ATTIC_HOME || join(process.env.APPDATA, 'Attic');
const PORT = Number(process.env.PORT) || 4477;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const MAX_BODY = 20 * 1024 * 1024;
const STARTUP_GRACE = 60_000;
const CLOSE_GRACE = 8_000;

const store = createStore(join(HOME, 'data'));

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/dither.js': ['dither.js', 'text/javascript; charset=utf-8'],
  '/bridge.js': ['bridge.js', 'text/javascript; charset=utf-8'],
  '/dom.js': ['dom.js', 'text/javascript; charset=utf-8'],
  '/calendar.js': ['calendar.js', 'text/javascript; charset=utf-8'],
  '/detail.js': ['detail.js', 'text/javascript; charset=utf-8'],
  '/icon.png': ['icon.png', 'image/png'],
};

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

// The window holds one open connection; when the last one is gone, the app has been closed.
const windows = new Set();
let exitTimer = null;

function exitAfter(ms) {
  clearTimeout(exitTimer);
  exitTimer = setTimeout(() => process.exit(0), ms);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const send = (res, status, body, type = 'text/plain; charset=utf-8') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};

async function handle(req, res) {
  // Only this app's own page may talk to the API, not other sites open in a browser.
  if (!ALLOWED_HOSTS.has(req.headers.host)) return send(res, 403, 'forbidden');
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) return send(res, 403, 'forbidden');

  const path = req.url.split('?')[0];

  if (path === '/api/alive' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    res.write(': connected\n\n');
    windows.add(res);
    clearTimeout(exitTimer);
    res.on('close', () => {
      windows.delete(res);
      if (!windows.size) exitAfter(CLOSE_GRACE);
    });
    return;
  }

  if (path === '/api/board') {
    if (req.method === 'GET') {
      return send(res, 200, JSON.stringify(await store.load()), 'application/json');
    }
    if (req.method === 'PUT') {
      if (!req.headers['content-type']?.startsWith('application/json')) {
        return send(res, 415, 'json only');
      }
      let board;
      try {
        board = JSON.parse(await readBody(req));
      } catch (err) {
        return send(res, err.status || 400, 'bad body');
      }
      try {
        await store.save(board);
      } catch (err) {
        console.error(err);
        return send(res, 500, 'save failed');
      }
      return send(res, 204, '');
    }
    return send(res, 405, 'method not allowed');
  }

  const asset = STATIC[path];
  if (req.method === 'GET' && asset) {
    return send(res, 200, await readFile(join(PUBLIC, asset[0])), asset[1]);
  }
  return send(res, 404, 'not found');
}

function findEdge() {
  const bases = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA];
  return bases
    .filter(Boolean)
    .map((base) => join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    .find(existsSync);
}

function openWindow() {
  if (!process.argv.includes('--open')) return;
  const edge = findEdge();
  if (!edge) {
    console.error('Microsoft Edge was not found.');
    return;
  }
  // A separate profile keeps this window apart from normal browsing. Without the last
  // two flags, Edge signs a new profile into the Windows account and starts sync.
  spawn(
    edge,
    [
      '--disable-sync',
      '--disable-features=msImplicitSignin',
      `--app=${URL_BASE}/`,
      `--user-data-dir=${join(HOME, 'window')}`,
      '--window-size=1280,800',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    { detached: true, stdio: 'ignore' },
  ).unref();
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) send(res, 500, 'server error');
    else res.end();
  });
});

server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  openWindow(); // already running, so this launch only needs a window
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Attic running at ${URL_BASE}`);
  exitAfter(STARTUP_GRACE);
  openWindow();
});
