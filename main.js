'use strict';

const {
  app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol, clipboard, ClipboardItem, nativeImage, nativeTheme,
} = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./db');
const cryptfile = require('./cryptfile'); // only to read encrypted HOTIT Manager databases when importing

const APP_NAME = 'LinkedIn Tracker'; // data folder and startup entry, don't change
const HOTIT_DIR_NAME = 'IT Business Manager'; // HOTIT Manager's data folder, where this app's data used to live

const USER_DIR = app.getPath('userData');
const CONFIG_FILE = path.join(USER_DIR, 'config.json');
const DEFAULT_DB_FILE = path.join(USER_DIR, 'tracker.db');
const BACKUP_DIR = path.join(USER_DIR, 'backups');
const WINDOW_FILE = path.join(USER_DIR, 'window.json');
const MAX_DAILY_BACKUPS = 30;

let win = null;

// Images are served from the database through avatar://img/<ownerId> and attachment://file/<id>
protocol.registerSchemesAsPrivileged([
  { scheme: 'avatar', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'attachment', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// ---------- config + database ----------

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(USER_DIR, { recursive: true });
  cryptfile.writeFileAtomic(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// Before an older database is upgraded to a new structure, keep a copy of it as it was.
const DB_OPEN_OPTIONS = {
  onUpgrade(oldVersion) {
    try {
      snapshotBefore(`upgrade-from-v${oldVersion}`);
    } catch (err) {
      console.error('Pre-upgrade backup failed:', err);
    }
  },
};

// For this session only: the default database, used while the configured one can't be reached.
// The configured location stays in config.json and is tried again at the next start.
let dbFileOverride = null;

function configuredDbFile() {
  return dbFileOverride || readConfig().dbPath || DEFAULT_DB_FILE;
}

function setDbPath(file) {
  dbFileOverride = null;
  writeConfig({ ...readConfig(), dbPath: file });
}

function useDefaultDatabaseForNow() {
  dbFileOverride = DEFAULT_DB_FILE;
  store.open(DEFAULT_DB_FILE, DB_OPEN_OPTIONS);
  runBackups();
}

/** Open the configured database. Returns false if the user chose to quit. */
async function openDatabase() {
  const file = configuredDbFile();
  const custom = path.resolve(file) !== path.resolve(DEFAULT_DB_FILE);
  // A database kept elsewhere (another drive, a synced folder) may just not be there yet. Never
  // create an empty one in its place: it would look like lost data and clash with the real file.
  while (custom && !fs.existsSync(file)) {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: APP_NAME,
      buttons: ['Try again', 'Use the default database for now', 'Quit'],
      defaultId: 0,
      cancelId: 2,
      message: 'Your database file can’t be found.',
      detail: `${file}\n\nIf it is on an external drive or in a synced folder (OneDrive, Dropbox…), connect the drive ` +
        'or wait for syncing to finish, then click Try again.\n\n' +
        'With “Use the default database for now” the app opens its default database this time, and looks for this file again next time it starts.',
    });
    if (response === 2) {
      app.quit();
      return false;
    }
    if (response === 1) {
      useDefaultDatabaseForNow();
      return true;
    }
  }
  try {
    store.open(file, DB_OPEN_OPTIONS);
    runBackups();
  } catch (err) {
    if (!custom) throw err;
    dialog.showErrorBox('Could not open database',
      `${file}\n\n${err.message}\n\nThe default database is used for now. The app tries this file again next time it starts.`);
    useDefaultDatabaseForNow();
  }
  return true;
}

/** Daily snapshots (last 30 kept) plus one per month kept forever. */
function runBackups() {
  if (!store.isOpen()) return;
  try {
    const daily = path.join(BACKUP_DIR, 'daily');
    const monthly = path.join(BACKUP_DIR, 'monthly');
    fs.mkdirSync(daily, { recursive: true });
    fs.mkdirSync(monthly, { recursive: true });
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const dayFile = path.join(daily, `tracker-${today}.db`);
    const monthFile = path.join(monthly, `tracker-${today.slice(0, 7)}.db`);
    if (!fs.existsSync(dayFile)) store.snapshotTo(dayFile);
    if (!fs.existsSync(monthFile)) fs.copyFileSync(dayFile, monthFile);
    const old = fs.readdirSync(daily).filter((f) => /^tracker-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    for (const f of old.slice(0, Math.max(0, old.length - MAX_DAILY_BACKUPS))) fs.unlinkSync(path.join(daily, f));
  } catch (err) {
    console.error('Backup failed:', err);
  }
}

function snapshotBefore(reason) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const file = path.join(BACKUP_DIR, `before-${reason}-${Date.now()}.db`);
  store.snapshotTo(file);
  return file;
}

// ---------- window ----------

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(WINDOW_FILE, 'utf8'));
  } catch {
    return { width: 1280, height: 820 };
  }
}

function saveWindowState() {
  if (!win) return;
  try {
    const state = { ...win.getNormalBounds(), maximized: win.isMaximized() };
    fs.writeFileSync(WINDOW_FILE, JSON.stringify(state), 'utf8');
  } catch {
    // ignore
  }
}

function createWindow() {
  const state = loadWindowState();
  win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width || 1280,
    height: state.height || 820,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d1117' : '#f5f7fb',
    title: APP_NAME,
    icon: path.join(__dirname, 'build', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  if (state.maximized) win.maximize();
  // launched by Windows at sign-in with "start minimized": sit in the taskbar instead of popping up
  win.once('ready-to-show', () => (process.argv.includes(MINIMIZED_ARG) ? win.minimize() : win.show()));
  win.on('close', saveWindowState);
  win.on('closed', () => { win = null; });

  // Never navigate the app window away; send links to the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  // Right-click spelling suggestions + copy/paste.
  win.webContents.on('context-menu', (_e, params) => {
    const items = params.dictionarySuggestions.map((s) => ({
      label: s,
      click: () => win.webContents.replaceMisspelling(s),
    }));
    if (items.length) items.push({ type: 'separator' });
    if (params.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    else if (params.selectionText) items.push({ role: 'copy' });
    if (items.length) Menu.buildFromTemplate(items).popup();
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

function openExternal(url) {
  try {
    const u = new URL(url);
    if (['http:', 'https:', 'mailto:'].includes(u.protocol)) shell.openExternal(u.toString());
  } catch {
    // ignore invalid urls
  }
}

function reloadRendererData(message) {
  if (win) win.webContents.send('data:replaced', { ...store.loadAll(), message });
}

// ---------- reading a database file to import ----------

/**
 * The bytes of a database file to import: this app's own backup, or a HOTIT Manager database or
 * backup, which may be encrypted with HOTIT Manager's password (asked for in the app window).
 * keys: data keys already unlocked, by file id (a HOTIT database and its backups share one key,
 * even after a password change), so the password is asked for only once.
 * Null if the password was asked for and not given.
 */
async function readDatabaseFile(file, keys = new Map()) {
  if (cryptfile.isEncrypted(file)) {
    const header = cryptfile.readHeader(file);
    let error = '';
    while (!keys.has(header.id)) {
      const password = await askPassword(path.basename(file), error);
      if (password === null) return null;
      try {
        keys.set(header.id, await cryptfile.unlock(header, password));
      } catch (err) {
        if (err.code !== 'WRONG_PASSWORD') throw err;
        error = 'That password is not right.';
      }
    }
    return cryptfile.decryptFile(file, keys.get(header.id)).plain;
  }
  if (!cryptfile.isPlainSqlite(file)) throw new Error('That file is not a database.');
  return fs.readFileSync(file);
}

// The password for an encrypted HOTIT Manager file is typed in the app window (Electron has no password dialog).
const passwordRequests = new Map();
let lastPasswordRequest = 0;

function askPassword(fileName, error) {
  return new Promise((resolve) => {
    const id = ++lastPasswordRequest;
    passwordRequests.set(id, resolve);
    win.webContents.send('ask-password', { id, fileName, error });
  });
}

ipcMain.on('ask-password:reply', (_e, id, password) => {
  const resolve = passwordRequests.get(id);
  if (!resolve) return;
  passwordRequests.delete(id);
  resolve(typeof password === 'string' ? password : null);
});

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function describeCounts(n) {
  return `${plural(n.contacts, 'contact')}, ${plural(n.messages, 'message')} and ${plural(n.images, 'image')}`;
}

/** Import from a file's bytes after a snapshot of the current data, and show the result. */
function importBytes(bytes, mode) {
  snapshotBefore('import');
  let added;
  try {
    added = store.importDatabase(bytes, mode);
  } catch (err) {
    throw new Error(`${err.message}\n\nNothing was imported: your data is unchanged.`);
  }
  reloadRendererData(mode === 'replace' ? 'Backup restored' : `Imported ${describeCounts(added)}`);
  return added;
}

// ---------- import from HOTIT Manager ----------

/**
 * HOTIT Manager's database and backups, newest first: the files LinkedIn messages can come from.
 * HOTIT Manager 3.8 and later removed them from its database, after keeping a copy as it was
 * (backups\before-upgrade-from-v….db).
 */
function hotitCandidates() {
  const dir = path.join(app.getPath('appData'), HOTIT_DIR_NAME);
  const files = [];
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    if (typeof cfg.dbPath === 'string' && cfg.dbPath) files.push(cfg.dbPath);
  } catch { /* no config: the default location */ }
  files.push(path.join(dir, 'tracker.db'));
  const backups = path.join(dir, 'backups');
  const inDir = (d, re) => {
    try {
      return fs.readdirSync(d).filter((f) => re.test(f)).map((f) => path.join(d, f));
    } catch {
      return [];
    }
  };
  const copies = [
    ...inDir(backups, /^before-.*\.db$/i),
    ...inDir(path.join(backups, 'daily'), /\.db$/i),
    ...inDir(path.join(backups, 'monthly'), /\.db$/i),
  ].map((f) => ({ f, t: fs.statSync(f).mtimeMs })).sort((a, b) => b.t - a.t).map((x) => x.f);
  return [...new Set([...files, ...copies].map((f) => path.resolve(f)))].filter((f) => fs.existsSync(f));
}

/**
 * The first of HOTIT Manager's files that still has LinkedIn contacts: { file, bytes, counts },
 * { file: null } when none has, or null when a password was asked for and not given.
 */
async function findHotitData() {
  const keys = new Map();
  for (const file of hotitCandidates()) {
    try {
      const bytes = await readDatabaseFile(file, keys);
      if (bytes === null) return null;
      const counts = store.describeDatabase(bytes);
      if (counts && counts.contacts) return { file, bytes, counts };
    } catch (err) {
      console.error(`Could not read ${file}:`, err); // e.g. damaged: try the next one
    }
  }
  return { file: null };
}

/**
 * File → Import from HOTIT Manager. auto: the offer made once, when the app starts with no
 * contacts on a PC where HOTIT Manager has data.
 */
async function importFromHotit({ auto = false } = {}) {
  if (auto) {
    if (readConfig().hotitOffered || store.counts().contacts || !hotitCandidates().length) return;
    writeConfig({ ...readConfig(), hotitOffered: true });
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Import', 'Not now'],
      defaultId: 0,
      cancelId: 1,
      message: 'Import your LinkedIn messages from HOTIT Manager?',
      detail: 'Your LinkedIn contacts and messages used to be kept in HOTIT Manager. They can be copied into this app now ' +
        '(HOTIT Manager’s files are only read, never changed). If its database is encrypted, you are asked for its password.\n\n' +
        'You can also do this later with File → Import from HOTIT Manager.',
    });
    if (response !== 0) return;
  }
  const found = await findHotitData();
  if (found === null) return; // password not given
  if (!found.file) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Choose a file…', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: 'No LinkedIn messages were found in HOTIT Manager’s data on this PC.',
      detail: 'If your HOTIT Manager database or a backup of it is somewhere else (another folder, a USB drive, OneDrive…), choose it.',
    });
    if (response === 0) await importFile();
    return;
  }
  if (!auto) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Import', 'Cancel', 'Choose another file…'],
      defaultId: 0,
      cancelId: 1,
      message: 'Import these LinkedIn messages?',
      detail: `Found ${describeCounts(found.counts)} in:\n${found.file}\n\n` +
        'They are added to your data here (anything already here is kept). HOTIT Manager’s file is only read, never changed.',
    });
    if (response === 1) return;
    if (response === 2) {
      await importFile();
      return;
    }
  }
  const added = importBytes(found.bytes, 'merge');
  dialog.showMessageBox(win, {
    type: 'info',
    message: 'Import finished',
    detail: `Imported ${describeCounts(added)} from:\n${found.file}`,
  });
}

/** Import from a file you choose: a HOTIT Manager database or backup, or a backup of this app. */
async function importFile() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import LinkedIn messages',
    defaultPath: BACKUP_DIR,
    properties: ['openFile'],
    filters: [{ name: 'LinkedIn Tracker backup or HOTIT Manager database (.db)', extensions: ['db'] }],
  });
  if (canceled || !filePaths.length) return;
  const bytes = await readDatabaseFile(filePaths[0]);
  if (bytes === null) return;
  const counts = store.describeDatabase(bytes);
  if (!counts || !counts.contacts) {
    dialog.showMessageBox(win, {
      type: 'error',
      message: 'That file has no LinkedIn contacts or messages.',
      detail: `${filePaths[0]}\n\nHOTIT Manager 3.8 and later no longer keep them in their database: choose the copy it made ` +
        'before that update (backups\\before-upgrade-from-v….db in HOTIT Manager’s data folder), or an older backup.',
    });
    return;
  }
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Merge into my data', 'Replace my data', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    message: 'How should this file be imported?',
    detail: `It has ${describeCounts(counts)}.\n\n` +
      'Merge adds anything that is not already here. Replace deletes your current data first.\n' +
      'Either way, a copy of your current database is saved to the backups folder first.',
  });
  if (response === 2) return;
  importBytes(bytes, response === 0 ? 'merge' : 'replace');
}

// ---------- export / move ----------

async function exportBackup() {
  const day = new Date().toISOString().slice(0, 10);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export backup',
    defaultPath: path.join(app.getPath('documents'), `linkedin-tracker-${day}.db`),
    filters: [{ name: 'LinkedIn Tracker backup', extensions: ['db'] }],
  });
  if (canceled || !filePath) return;
  // a copy of the whole database; restore it with Import backup
  const file = /\.db$/i.test(filePath) ? filePath : `${filePath}.db`;
  store.snapshotTo(file);
  dialog.showMessageBox(win, { type: 'info', message: 'Backup exported', detail: file });
}

async function moveDatabase() {
  const current = store.currentFile();
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Choose where to keep your database',
    defaultPath: path.join(app.getPath('documents'), `${APP_NAME}.db`),
    buttonLabel: 'Use this location',
    filters: [{ name: 'LinkedIn Tracker database', extensions: ['db'] }],
    properties: ['showOverwriteConfirmation'],
  });
  if (canceled || !filePath || path.resolve(filePath) === path.resolve(current)) return;

  let mode = 'copy';
  if (fs.existsSync(filePath)) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Open the existing database', 'Overwrite it with my current data', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: 'A file already exists there.',
      detail: filePath,
    });
    if (response === 2) return;
    mode = response === 0 ? 'open' : 'copy';
  }
  try {
    if (mode === 'copy') {
      const tmp = `${filePath}.tmp`;
      store.snapshotTo(tmp);
      fs.renameSync(tmp, filePath);
    }
    store.open(filePath, DB_OPEN_OPTIONS);
    setDbPath(filePath);
  } catch (err) {
    store.open(current, DB_OPEN_OPTIONS);
    dialog.showErrorBox('Could not use that location', err.message);
    return;
  }
  reloadRendererData(mode === 'open' ? 'Opened database' : 'Database moved');
}

/** For the menu and Settings: an error is shown to the user instead of getting lost. */
function showingErrors(title, fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      console.error(`${title}:`, err);
      dialog.showErrorBox(title, err.message);
      return undefined;
    }
  };
}

const runExportBackup = showingErrors('Could not export the backup', exportBackup);
const runImportFile = showingErrors('Could not import', importFile);
const runImportFromHotit = showingErrors('Could not import from HOTIT Manager', importFromHotit);
const runMoveDatabase = showingErrors('Could not change the database location', moveDatabase);

// ---------- menu ----------

function buildMenu() {
  const send = (cmd) => () => win && win.webContents.send('menu', cmd);
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New contact…', accelerator: 'CmdOrCtrl+N', click: send('new') },
        { label: 'Find', accelerator: 'CmdOrCtrl+F', click: send('focus-search') },
        { type: 'separator' },
        { label: 'Manage LinkedIn accounts…', click: send('accounts') },
        { type: 'separator' },
        { label: 'Import from HOTIT Manager…', click: () => runImportFromHotit() },
        { label: 'Export backup…', click: runExportBackup },
        { label: 'Import backup…', click: runImportFile },
        { label: 'Change database location…', click: runMoveDatabase },
        { label: 'Open data folder', click: () => shell.showItemInFolder(store.currentFile()) },
        { label: 'Open backups folder', click: () => { fs.mkdirSync(BACKUP_DIR, { recursive: true }); shell.openPath(BACKUP_DIR); } },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: send('settings') },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'zoomIn', accelerator: 'CmdOrCtrl+=' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Help',
      submenu: [{ label: 'Keyboard shortcuts', click: send('shortcuts') }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- ipc ----------

const DB_OPS = {
  createAccount: store.createAccount,
  updateAccount: store.updateAccount,
  deleteAccount: store.deleteAccount,
  createContact: store.createContact,
  updateContact: store.updateContact,
  deleteContact: store.deleteContact,
  restoreContact: store.restoreContact,
  createMessage: store.createMessage,
  updateMessage: store.updateMessage,
  deleteMessage: store.deleteMessage,
  restoreMessage: store.restoreMessage,
  setMessageSeen: store.setMessageSeen,
  setAvatar: store.setAvatar,
  removeAvatar: store.removeAvatar,
  setSetting: store.setSetting,
};

ipcMain.handle('data:load', () => store.loadAll());
ipcMain.handle('db', (_e, op, ...args) => {
  if (!Object.hasOwn(DB_OPS, op)) throw new Error(`Unknown operation: ${op}`);
  return DB_OPS[op](...args);
});
ipcMain.handle('open:external', (_e, url) => openExternal(url));
ipcMain.handle('open:data-folder', () => shell.showItemInFolder(store.currentFile()));
ipcMain.handle('open:backups-folder', () => { fs.mkdirSync(BACKUP_DIR, { recursive: true }); shell.openPath(BACKUP_DIR); });
ipcMain.handle('backup:export', runExportBackup);
ipcMain.handle('backup:import', runImportFile);
ipcMain.handle('db:move', runMoveDatabase);
ipcMain.handle('import:hotit', (_e, auto) => runImportFromHotit({ auto: auto === true }));
// the theme chosen in Settings → Appearance; remembered here too, so the window opens in its colors
ipcMain.handle('theme:set', (_e, theme) => {
  if (!['light', 'dark', 'system'].includes(theme)) return;
  nativeTheme.themeSource = theme;
  const cfg = readConfig();
  if (cfg.theme !== theme) writeConfig({ ...cfg, theme });
});

// ---------- start with Windows ----------

const MINIMIZED_ARG = '--minimized';
const STARTUP_ENTRY_NAME = APP_NAME; // name shown in Windows Settings → Apps → Startup

/** The exe Windows should launch. The portable build runs from a temp copy, so use the original file. */
function startupExePath() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

function getStartup() {
  if (!app.isPackaged) return { supported: false, enabled: false, minimized: false };
  // Electron's openAtLogin only matches its default entry name, so look the entry up by our name.
  // `enabled` is false when the user switched it off in Windows Settings / Task Manager.
  const { launchItems = [] } = app.getLoginItemSettings({ path: startupExePath(), name: STARTUP_ENTRY_NAME });
  const item = launchItems.find((i) => i.name === STARTUP_ENTRY_NAME);
  return {
    supported: true,
    enabled: !!item && item.enabled !== false,
    minimized: !!readConfig().startMinimized, // Windows doesn't report the arguments back reliably
  };
}

ipcMain.handle('startup:get', () => getStartup());
ipcMain.handle('startup:set', (_e, { enabled, minimized }) => {
  if (!app.isPackaged) return getStartup();
  // Windows keeps one startup entry per name, so this replaces any previous setting
  app.setLoginItemSettings({
    openAtLogin: !!enabled,
    path: startupExePath(),
    args: minimized ? [MINIMIZED_ARG] : [],
    name: STARTUP_ENTRY_NAME,
  });
  writeConfig({ ...readConfig(), startMinimized: !!(enabled && minimized) });
  return getStartup();
});

const EXT_FOR_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

ipcMain.handle('attachment:save', async (_e, id) => {
  const a = store.getAttachment(id);
  if (!a) return false;
  const ext = EXT_FOR_MIME[a.mime] || 'img';
  const base = (a.name || 'image').replace(/[\\/:*?"<>|]+/g, '_').replace(/\.[a-z0-9]{2,5}$/i, '');
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save image',
    defaultPath: path.join(app.getPath('downloads'), `${base}.${ext}`),
    filters: [{ name: 'Image', extensions: [ext] }],
  });
  if (canceled || !filePath) return false;
  fs.writeFileSync(filePath, a.data);
  return true;
});

ipcMain.handle('attachment:copy', async (_e, id) => {
  const a = store.getAttachment(id);
  if (!a) return false;
  // Clipboard images are PNG; convert JPEGs. (nativeImage cannot decode webp/gif.)
  const png = a.mime === 'image/png' ? a.data : nativeImage.createFromBuffer(a.data).toPNG();
  if (!png.length) return false;
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
  return true;
});

// ---------- lifecycle ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(async () => {
    app.setAppUserModelId('com.jamesdavidclarke.linkedintracker');
    const { theme } = readConfig();
    if (['light', 'dark', 'system'].includes(theme)) nativeTheme.themeSource = theme;
    if (!(await openDatabase())) return; // quitting
    protocol.handle('avatar', (req) => {
      const ownerId = decodeURIComponent(new URL(req.url).pathname.slice(1));
      const a = store.getAvatar(ownerId);
      if (!a) return new Response(null, { status: 404 });
      return new Response(a.data, { headers: { 'content-type': a.mime, 'cache-control': 'max-age=31536000' } });
    });
    protocol.handle('attachment', (req) => {
      const id = decodeURIComponent(new URL(req.url).pathname.slice(1));
      const a = store.getAttachment(id);
      if (!a) return new Response(null, { status: 404 });
      return new Response(a.data, { headers: { 'content-type': a.mime, 'cache-control': 'max-age=31536000' } });
    });
    buildMenu();
    createWindow();
    // keep making daily backups if the app is left open for days
    setInterval(runBackups, 6 * 60 * 60 * 1000);
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => store.close());
}
