// electron/main.cjs
//
// The desktop app (Windows and macOS). It starts the same server you run with `npm run server`,
// inside this app, and shows the interface in a window. Everything you save (the database and the
// settings, including your YouTube key) lives in the operating system's per-user app-data folder:
//   Windows:  %APPDATA%\Retro-Cable TV
//   macOS:    ~/Library/Application Support/Retro-Cable TV
const { app, BrowserWindow, Menu, session, shell, dialog } = require('electron');
const path = require('path');

app.setName('Retro-Cable TV'); // before anything asks for the data folder, so dev and installed copies agree

// Where this install keeps its files (override with RETROTV_DATA_DIR, e.g. to try the app on a copy of old data)
process.env.RETROTV_DATA_DIR = process.env.RETROTV_DATA_DIR || app.getPath('userData');
// The built React app, which the bundled server hands out
process.env.RETROTV_STATIC_DIR = path.join(__dirname, '..', 'dist');

// Videos should start by themselves (the power-on screen already needs a click, but this keeps it from ever blocking)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (process.env.RETROTV_DISABLE_GPU === '1') app.disableHardwareAcceleration(); // escape hatch for flaky graphics drivers

let mainWindow = null;
let server = null;

// The built-in database driver (node:sqlite) needs Node 22.13+, which any recent Electron includes
function checkNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    throw new Error(
      `This Electron is too old (it contains Node ${process.versions.node}; Node 22.13 or newer is needed). ` +
        'Reinstall with: npm install --save-dev electron@latest'
    );
  }
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    // Needed on a Mac: Cmd+C / Cmd+V / Cmd+A only work in text fields when an Edit menu exists
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' }, // F11 (Ctrl+Cmd+F on a Mac); the app's own F key works too
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(port) {
  const origin = `http://localhost:${port}`;

  mainWindow = new BrowserWindow({
    width: 1366,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#000000',
    title: 'Retro-Cable TV',
    show: false,
    autoHideMenuBar: true, // press Alt to show the menu on Windows
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // `--fullscreen` on the command line (or RETROTV_FULLSCREEN=1) starts in full screen
    if (process.argv.includes('--fullscreen') || process.env.RETROTV_FULLSCREEN === '1') mainWindow.setFullScreen(true);
  });

  // The window only ever shows this app. Links elsewhere open in your normal browser instead.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(origin)) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadURL(origin);
}

async function start() {
  try {
    checkNodeVersion();

    // The app asks for nothing but full screen (for the F key); deny everything else (camera, location, ...)
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'fullscreen'));

    buildMenu();
    const { startServer } = require('../server.cjs');
    server = await startServer({ port: 3001 }); // takes the next free port if 3001 is busy
    createWindow(server.port);
  } catch (err) {
    console.error(err);
    dialog.showErrorBox('Retro-Cable TV could not start', String(err.message || err));
    app.quit();
  }
}

// Only one copy at a time (two would fight over the same database)
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(start);

  app.on('activate', () => {
    // macOS: clicking the dock icon when no window is open
    if (!mainWindow && server) createWindow(server.port);
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', () => {
    server?.close();
  });
}
