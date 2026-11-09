import { app, BrowserWindow, ipcMain, Menu, protocol, screen } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, 'public');
const BACKGROUND = '#0c0c0b';

const ASSETS = {
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

// A fixed location, so running from source and the installed app share one board.
const home = process.env.ATTIC_HOME || join(app.getPath('appData'), 'Attic');
app.setPath('userData', home);

const store = createStore(join(home, 'data'));
const windowFile = join(home, 'window.json');

let win = null;

if (!app.requestSingleInstanceLock()) app.quit();

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function savedBounds() {
  try {
    const saved = JSON.parse(readFileSync(windowFile, 'utf8'));
    // Ignore a position left over from a monitor that is no longer connected.
    const onScreen = screen.getAllDisplays().some(({ workArea: a }) =>
      saved.x < a.x + a.width && saved.x + saved.width > a.x && saved.y < a.y + a.height && saved.y + saved.height > a.y);
    return onScreen ? saved : {};
  } catch {
    return {};
  }
}

function createWindow() {
  const { maximized, ...bounds } = savedBounds();

  win = new BrowserWindow({
    width: 1280,
    height: 800,
    ...bounds,
    minWidth: 420,
    minHeight: 320,
    show: false,
    title: 'Attic',
    backgroundColor: BACKGROUND,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: BACKGROUND, symbolColor: '#8f8c81', height: 52 },
    webPreferences: {
      preload: join(ROOT, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });

  if (maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  win.on('close', () => {
    const state = { ...win.getNormalBounds(), maximized: win.isMaximized() };
    writeFile(windowFile, JSON.stringify(state)).catch(console.error);
  });
  win.on('closed', () => {
    win = null;
  });

  win.loadURL('app://board/');
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);

  protocol.handle('app', async (request) => {
    const asset = ASSETS[new URL(request.url).pathname];
    if (!asset) return new Response('not found', { status: 404 });
    return new Response(await readFile(join(PUBLIC, asset[0])), {
      headers: { 'content-type': asset[1] },
    });
  });

  ipcMain.handle('board:load', () => store.load());
  ipcMain.handle('board:save', (_event, board) => store.save(board));
  ipcMain.on('board:save-now', (event, board) => {
    store.save(board).then(
      () => { event.returnValue = true; },
      (err) => {
        console.error(err);
        event.returnValue = false;
      },
    );
  });

  createWindow();
});

app.on('window-all-closed', () => app.quit());
