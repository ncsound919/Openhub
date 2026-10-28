const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const isDev = !app.isPackaged;

// The server binds PORT from .env (project config wins over the machine env).
// Read the same file here so the shell follows the server instead of assuming
// 3000; a machine-level PORT=0 or a junk value must never become the URL.
try {
  require('dotenv').config({ path: path.join(__dirname, '.env'), override: true, quiet: true });
} catch {
  // dotenv missing (packaged build) or no .env file: fall back to the process env.
}

const APP_PORT = (() => {
  const n = Number(process.env.OPENHUB_PORT || process.env.PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 3000;
})();
const APP_URL = `http://localhost:${APP_PORT}`;
const APP_ORIGIN = new URL(APP_URL).origin;
const HEALTH_URL = `${APP_ORIGIN}/api/health`;
const HEALTH_RETRIES = 10;
const HEALTH_RETRY_DELAY_MS = 1000;

// Verify that the thing answering on APP_URL is actually OpenHub before loading
// it, so we never hand an unknown local service a privileged renderer.
async function isOpenHubServer() {
  for (let attempt = 0; attempt < HEALTH_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(HEALTH_URL, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        const body = await res.json();
        // OpenHub's /api/health reports its execution engine plus a timestamp.
        // 'opencode' is the current engine; 'axiom' is accepted so an older
        // server already running on the port still loads in the shell.
        const engines = ['opencode', 'axiom'];
        if (body && engines.includes(body.engine) && typeof body.timestamp === 'string') {
          return true;
        }
        return false; // Something answered, but it is not OpenHub.
      }
    } catch {
      // Server still booting or unreachable; retry.
    }
    await new Promise((r) => setTimeout(r, HEALTH_RETRY_DELAY_MS));
  }
  return false;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showErrorPage(win, message) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>OpenHub</title></head>
<body style="background:#0A0C10;color:#F0F6FC;font-family:sans-serif;padding:40px">
<h2>OpenHub could not start</h2><p>${escapeHtml(message)}</p></body></html>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

function isAppUrl(url) {
  try {
    return new URL(url).origin === APP_ORIGIN;
  } catch {
    return false;
  }
}

function hardenWebContents(contents) {
  contents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  contents.on('will-redirect', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    try {
      const { protocol } = new URL(url);
      if (protocol === 'http:' || protocol === 'https:') {
        shell.openExternal(url);
      }
    } catch {
      // Malformed URL: ignore.
    }
    return { action: 'deny' };
  });
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0A0C10',
      symbolColor: '#F0F6FC'
    }
  });

  hardenWebContents(mainWindow.webContents);

  // In dev the server is started by `npm run electron:dev` (wait-on); in a
  // packaged build we assume the Node server runs concurrently on APP_PORT.
  // Either way, confirm it is OpenHub before loading it.
  const win = mainWindow;
  isOpenHubServer().then((ok) => {
    if (win.isDestroyed()) return;
    if (!ok) {
      showErrorPage(win, `No OpenHub server responded at ${APP_URL}. Start the server and relaunch.`);
      return;
    }
    win.loadURL(APP_URL);
    if (isDev) {
      win.webContents.openDevTools();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('ready', createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});
