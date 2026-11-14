// Glimt main process: owns the dock window, the settings window, the tray icon,
// the PowerShell helper (media + volume + network + processes) and CPU/RAM/disk sampling.
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, shell, dialog, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');

app.setAppUserModelId('se.glimt.dock');

/* ---------------- Log file (%APPDATA%\Glimt\glimt.log) ---------------- */
// Helps when something goes wrong at login, where there is no console to read.
const logFile = () => path.join(app.getPath('userData'), 'glimt.log');
function log(...args) {
  const line = new Date().toISOString() + ' ' + args.map(a => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n';
  try {
    fs.mkdirSync(path.dirname(logFile()), { recursive: true });
    const st = fs.existsSync(logFile()) ? fs.statSync(logFile()) : null;
    if (st && st.size > 512 * 1024) fs.renameSync(logFile(), logFile() + '.old');
    fs.appendFileSync(logFile(), line);
  } catch (e) {
    try { process.stderr.write('log failed: ' + (e && e.stack) + '\n'); } catch {}
    try { fs.appendFileSync(path.join(os.tmpdir(), 'glimt-fallback.log'), 'log failed: ' + e.message + '\n' + line); }
    catch (e2) { try { process.stderr.write('fallback failed: ' + (e2 && e2.stack) + '\n'); } catch {} }
  }
}
const origErr = console.error, origLog = console.log;
// Without a console (e.g. started by Task Scheduler) writing to stdout can throw, so guard it
console.error = (...a) => { log('ERROR', ...a); try { origErr(...a); } catch {} };
console.log = (...a) => { log(...a); try { origLog(...a); } catch {} };
process.on('uncaughtException', e => log('uncaughtException', e));
process.on('unhandledRejection', e => log('unhandledRejection', e));
log('start', { exe: process.execPath, args: process.argv.slice(1), cwd: process.cwd(), packaged: app.isPackaged });

const DOCK_HEIGHT = 760; // room for the dock plus a popover above it (the rest is transparent and click-through)

/* ---------------- Settings ---------------- */

const DEFAULTS = {
  widgets: [
    { id: 'start', on: true },
    { id: 'search', on: true },
    { id: 'apps', on: true },
    { id: 'spacer', on: true },
    { id: 'media', on: true },
    { id: 'spacer', on: true },
    { id: 'cpu', on: true },
    { id: 'ram', on: true },
    { id: 'net', on: true },
    { id: 'disk', on: false },
    { id: 'battery', on: false },
    { id: 'volume', on: true },
    { id: 'weather', on: true },
    { id: 'control', on: true },
    { id: 'clock', on: true }
  ],
  weather: { city: 'Stockholm', name: 'Stockholm', lat: 59.3293, lon: 18.0686 },
  look: {
    theme: 'dark',          // dark | light
    accent: '#7cc4ff',
    accentFromArt: true,    // tint media widget from album art
    opacity: 0.45,
    blur: 24,               // unused since v3 (CSS blur can't see the desktop); see glass
    glass: 'strong',        // off | light | strong: real Windows blur behind dock and popovers
    radius: 16,
    scale: 1,
    position: 'bottom',     // bottom | top
    layout: 'floating',     // floating | full
    margin: 10,
    labels: true
  },
  media: {
    source: null,           // preferred media source app id, null = automatic
    dockControls: true,
    showVolume: true
  },
  general: {
    alwaysOnTop: true,
    hideFullscreen: true,
    startWithWindows: true,  // a dock that replaces the taskbar should be there after login
    overTaskbar: false,
    replaceTaskbar: false,   // hide Windows' taskbar while Glimt runs and reserve the dock's strip
    startButton: 'windows',  // glimt = Glimt's own launcher above the dock, windows = Windows Start
    searchShortcut: true,    // Alt+Space opens the launcher
    winKey: false,           // the Win key alone opens Glimt's search instead of Windows Start
    winS: true,              // Win+S opens Glimt's search
    showRunning: true        // show open windows in the apps widget
  },
  apps: null                // filled with detected apps on first run
};

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings;

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function merge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(patch || {})) {
    out[k] = isObj(base[k]) && isObj(patch[k]) ? merge(base[k], patch[k]) : patch[k];
  }
  return out;
}

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8').replace(/^﻿/, '')); }
  catch (e) { log('settings not loaded from', settingsFile(), e.message); try { process.stderr.write('settings load: ' + e.stack + '\n'); } catch {} }
  settings = merge(DEFAULTS, saved);
  if (!Array.isArray(settings.apps)) settings.apps = detectApps();
  // The Bluetooth pill moved into the control center
  settings.widgets = settings.widgets.filter(w => w.id !== 'bluetooth');
  if (!settings.widgets.some(w => w.id === 'control')) {
    const at = settings.widgets.findIndex(w => w.id === 'clock');
    settings.widgets.splice(at < 0 ? settings.widgets.length : at, 0, { id: 'control', on: true });
  }
  // Older settings files lack newer widgets: insert each near its default position
  DEFAULTS.widgets.forEach((d, i) => {
    if (d.id === 'spacer' || settings.widgets.some(w => w.id === d.id)) return;
    settings.widgets.splice(Math.min(i, settings.widgets.length), 0, { ...d });
  });
  // v2: the Win key and the dock's Start button open Windows Start again (only Win+S / search open Glimt's search)
  if ((settings.settingsVersion || 1) < 2) {
    settings.general.winKey = false;
    settings.general.startButton = 'windows';
    settings.settingsVersion = 2;
    saveSettings();
  }
  // v3: real glass blur; a lighter tint so the blur shows through like the search window
  if (settings.settingsVersion < 3) {
    settings.look.opacity = Math.min(settings.look.opacity, 0.45);
    settings.settingsVersion = 3;
    saveSettings();
  }
}

let saveTimer;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
      fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
    } catch (e) { console.error('Could not save settings', e); }
  }, 300);
}

function detectApps() {
  const env = process.env;
  const candidates = [
    { name: 'Utforskaren', path: path.join(env.WINDIR || 'C:\\Windows', 'explorer.exe') },
    { name: 'Spotify', path: path.join(env.APPDATA || '', 'Spotify', 'Spotify.exe') },
    { name: 'Chrome', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
    { name: 'Edge', path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
    { name: 'Discord', path: path.join(env.LOCALAPPDATA || '', 'Discord', 'Update.exe') },
    { name: 'VS Code', path: path.join(env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe') },
    { name: 'Steam', path: 'C:\\Program Files (x86)\\Steam\\steam.exe' }
  ];
  return candidates.filter(c => { try { return fs.existsSync(c.path); } catch { return false; } })
    .filter(c => c.name !== 'Discord'); // Discord's Update.exe needs args; users can add it manually
}

/* ---------------- Windows ---------------- */

let dock = null;
let settingsWin = null;
let tray = null;
let quitting = false;
let hiddenForFullscreen = false;

function dockBounds() {
  const disp = screen.getPrimaryDisplay();
  const g = settings.general;
  const area = g.overTaskbar || g.replaceTaskbar ? disp.bounds : disp.workArea;
  const h = Math.min(DOCK_HEIGHT, area.height);
  const y = settings.look.position === 'top' ? area.y : area.y + area.height - h;
  return { x: area.x, y, width: area.width, height: h };
}

function createDock() {
  dock = new BrowserWindow({
    ...dockBounds(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    title: 'Glimt',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  applyWindowSettings();
  dock.setIgnoreMouseEvents(true, { forward: true });
  dock.loadFile(path.join(__dirname, 'src', 'dock.html'));
  dock.once('ready-to-show', () => dock.showInactive());
  dock.on('closed', () => { dock = null; });
  dock.on('hide', hideBackdrops);
  dock.on('show', () => setTimeout(applyDockRegion, 50));
  dock.on('move', () => setTimeout(applyDockRegion, 50));
  dock.on('resize', () => setTimeout(applyDockRegion, 50));
}

function applyWindowSettings() {
  if (!dock) return;
  dock.setBounds(dockBounds());
  dock.setAlwaysOnTop(!!settings.general.alwaysOnTop, 'screen-saver');
  applyTaskbar();
}

// Autostart through Task Scheduler (a per-user "at logon" task, no admin needed).
// The Run registry key did not work on this machine: Explorer skipped Glimt's entry at login
// (unsigned exe) even with StartupApproved set, so the Run entries are only cleaned up here.
const TASK_NAME = 'Glimt';
function run(cmd, args) {
  return new Promise(resolve => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout) => resolve({ code: err ? (err.code || 1) : 0, out: String(stdout || '') }));
  });
}
const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function applyAutostart() {
  const on = !!settings.general.startWithWindows;
  // Remove the old Run-key entries from earlier versions
  try {
    for (const name of ['se.glimt.dock', 'Glimt']) app.setLoginItemSettings({ openAtLogin: false, name });
  } catch {}
  await run('reg.exe', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run', '/v', 'Glimt', '/f']);

  if (!on) {
    const r = await run('schtasks.exe', ['/Delete', '/TN', TASK_NAME, '/F']);
    log('autostart off, task delete', r.code);
    return;
  }
  if (!app.isPackaged) { log('autostart: dev build, task not created'); return; }

  const exe = process.execPath;
  const q = await run('schtasks.exe', ['/Query', '/TN', TASK_NAME, '/XML']);
  if (q.code === 0 && q.out.includes(xmlEsc(exe))) { log('autostart task already present'); return; }

  const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Startar Glimt-dockan när du loggar in.</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xmlEsc(user)}</UserId><Delay>PT3S</Delay></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xmlEsc(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
    <StartWhenAvailable>true</StartWhenAvailable>
  </Settings>
  <Actions Context="Author"><Exec><Command>${xmlEsc(exe)}</Command></Exec></Actions>
</Task>`;
  const f = path.join(app.getPath('temp'), 'glimt-task.xml');
  try { fs.writeFileSync(f, '﻿' + xml, 'utf16le'); } catch (e) { log('autostart xml write failed', e); return; }
  const r = await run('schtasks.exe', ['/Create', '/TN', TASK_NAME, '/XML', f, '/F']);
  log('autostart task create', r.code);
}

function dockHwnd() {
  if (!dock) return 0;
  const b = dock.getNativeWindowHandle();
  return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0);
}

// Hide Windows' taskbar and reserve the dock's strip of the screen, or undo both.
function applyTaskbar() {
  if (!dock) return;
  if (!settings.general.replaceTaskbar) {
    if (lastTaskbarKey !== 'off') sendHelper({ cmd: 'taskbar', hide: false });
    lastTaskbarKey = 'off';
    return;
  }
  const disp = screen.getPrimaryDisplay();
  const sf = disp.scaleFactor || 1;
  const b = disp.bounds;
  const stripDip = Math.ceil(58 * settings.look.scale + settings.look.margin * 2 + 2);
  const strip = Math.round(stripDip * sf);
  const l = Math.round(b.x * sf), r = Math.round((b.x + b.width) * sf);
  const top = settings.look.position === 'top';
  const t = top ? Math.round(b.y * sf) : Math.round((b.y + b.height) * sf) - strip;
  const msg = { cmd: 'taskbar', hide: true, hwnd: dockHwnd(), edge: top ? 1 : 3, l, t, r, b: t + strip };
  const key = JSON.stringify(msg);
  if (key === lastTaskbarKey) return; // the reserved strip changes the work area; don't loop on that event
  lastTaskbarKey = key;
  sendHelper(msg);
}
let lastTaskbarKey = null;

function openSettings(tab) {
  if (settingsWin) {
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.show(); settingsWin.focus();
    if (tab) settingsWin.webContents.send('goto', tab);
    return;
  }
  const light = settings.look.theme === 'light';
  settingsWin = new BrowserWindow({
    width: 920, height: 680, minWidth: 720, minHeight: 520,
    title: 'Glimt – Inställningar',
    backgroundColor: light ? '#f3f5f8' : '#0f1319',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: light ? '#f3f5f8' : '#0f1319', symbolColor: light ? '#1b2330' : '#e8edf2', height: 40 },
    show: false,
    autoHideMenuBar: true,
    icon: trayImage(64),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true
    }
  });
  settingsWin.loadFile(path.join(__dirname, 'src', 'settings.html'), tab ? { hash: tab } : undefined);
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => { settingsWin = null; });
}

function broadcast(channel, data) {
  for (const w of [dock, settingsWin, spot]) {
    if (w && !w.isDestroyed()) w.webContents.send(channel, data);
  }
}

/* ---------------- Tray ---------------- */

// Draws the tray icon in code: a rounded square with a gradient and a small dock bar.
function trayImage(size = 32) {
  const buf = Buffer.alloc(size * size * 4);
  const r = size * 0.24;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = Math.max(r - x, x - (size - 1 - r), 0);
      const dy = Math.max(r - y, y - (size - 1 - r), 0);
      const d = Math.hypot(dx, dy);
      let a = d <= r - 1 ? 1 : d <= r ? r - d : 0;
      if (!a) continue;
      const t = (x + y) / (2 * size);
      let R = 124 + (95 - 124) * t, G = 196 + (211 - 196) * t, B = 255 + (154 - 255) * t;
      const inBar = y > size * 0.62 && y < size * 0.76 && x > size * 0.2 && x < size * 0.8;
      const inDot = Math.hypot(x - size * 0.5, y - size * 0.38) < size * 0.13;
      if (inBar || inDot) { R = 10; G = 18; B = 30; }
      buf[i] = B; buf[i + 1] = G; buf[i + 2] = R; buf[i + 3] = Math.round(a * 255);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function createTray() {
  tray = new Tray(trayImage(32));
  tray.setToolTip('Glimt');
  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
  tray.on('click', () => openSettings());
}

function menuTemplate() {
  return [
    { label: 'Inställningar', click: () => openSettings() },
    { label: 'Lägg till widgets', click: () => openSettings('widgets') },
    { label: 'Utseende', click: () => openSettings('look') },
    { type: 'separator' },
    { label: dock && dock.isVisible() ? 'Göm dockan' : 'Visa dockan', click: toggleDock },
    { label: 'Starta om dockan', click: () => { if (dock) dock.reload(); } },
    { type: 'separator' },
    { label: 'Avsluta Glimt', click: () => app.quit() }
  ];
}

function toggleDock() {
  if (!dock) return;
  if (dock.isVisible()) dock.hide(); else dock.showInactive();
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
}

/* ---------------- Helper process ---------------- */

let helper = null;
let helperBuf = '';
let lastMedia = null;
let lastStats = null;
let lastWindows = null;
let lastTaskbar = null;
const art = { key: null, data: null };

function helperPath() {
  return path.join(__dirname, 'helper', 'glimt-helper.ps1').replace('app.asar', 'app.asar.unpacked');
}

function startHelper() {
  helper = spawn('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath()],
    // Not detached: powershell.exe won't start as a DETACHED_PROCESS. The helper starts its own
    // watchdog instead, which lands outside Electron's job object and survives a crash.
    { windowsHide: true });
  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', chunk => {
    helperBuf += chunk;
    let nl;
    while ((nl = helperBuf.indexOf('\n')) >= 0) {
      const line = helperBuf.slice(0, nl).trim();
      helperBuf = helperBuf.slice(nl + 1);
      if (line) onHelperMessage(line);
    }
  });
  helper.stderr.on('data', d => console.error('[helper]', String(d).trim()));
  helper.on('exit', () => {
    helper = null;
    if (!quitting) setTimeout(startHelper, 3000);
  });
}

// Sent each time the helper (re)starts
function initHelper() {
  sendHelper({ cmd: 'init', dock: dockHwnd(), pid: process.pid });
  if (settings.media.source) sendHelper({ cmd: 'source', id: settings.media.source });
  lastTaskbarKey = null;
  applyTaskbar();
  sendHelper({ cmd: 'startapps' });
  glassSpot();
  backdropGlass.clear(); applyDockRegion();
}

/* ---------------- App index for the launcher ---------------- */

let lnkApps = [];
let startApps = [];
let appIndex = [];
const SKIP_LNK = /uninstall|avinstallera|readme|läs mig|help|hjälp|documentation|dokumentation|website|webbplats|release notes/i;

async function scanStartMenu() {
  const dirs = [
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  ];
  const found = new Map();
  async function walk(dir, depth) {
    let entries = [];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) await walk(p, depth + 1);
      else if (/\.lnk$/i.test(e.name)) {
        const name = e.name.replace(/\.lnk$/i, '');
        if (!SKIP_LNK.test(name) && !found.has(name.toLowerCase())) found.set(name.toLowerCase(), { name, path: p, kind: 'lnk' });
      }
    }
  }
  for (const d of dirs) await walk(d, 0);
  lnkApps = [...found.values()];
  buildAppIndex();
}

function buildAppIndex() {
  const byName = new Map(lnkApps.map(a => [a.name.toLowerCase(), a]));
  for (const s of startApps) {
    const k = String(s.name || '').toLowerCase();
    if (!k || byName.has(k) || SKIP_LNK.test(k)) continue;
    // Desktop apps already appear via their shortcut; the rest (Store apps, Settings, Calculator…) launch by AppID
    byName.set(k, { name: s.name, id: s.id, kind: 'uwp' });
  }
  appIndex = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'sv'));
  broadcast('apps-index', appIndex);
}

/* ---------------- Epic Games account switcher ---------------- */
// Epic keeps the "remember me" login in GameUserSettings.ini ([RememberMe]/[Offline] Data) and the
// signed-in account's id in the registry. Each saved account is a copy of that ini.
// Learned the hard way (2026-11-14):
//  - Epic replaces the login token a few seconds after every start, and the old one stops working.
//    So after Epic starts, the account's copy must be refreshed from the ini (epicWatch).
//  - Signing out in Epic revokes the token: new accounts are added by clearing the login instead.
//  - A copy must never be overwritten with an ini that holds no login.

const EPIC_INI = () => path.join(process.env.LOCALAPPDATA || '', 'EpicGamesLauncher', 'Saved', 'Config', 'WindowsEditor', 'GameUserSettings.ini');
const EPIC_REG = 'HKCU\\Software\\Epic Games\\Unreal Engine\\Identifiers';
const epicDir = () => path.join(app.getPath('userData'), 'epic');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function epicLoad() {
  try { const l = JSON.parse(fs.readFileSync(path.join(epicDir(), 'accounts.json'), 'utf8')); return Array.isArray(l) ? l : []; } catch { return []; }
}
function epicStore(list) {
  fs.mkdirSync(epicDir(), { recursive: true });
  fs.writeFileSync(path.join(epicDir(), 'accounts.json'), JSON.stringify(list, null, 2));
}
const epicCopy = id => path.join(epicDir(), id.replace(/[^\w-]/g, ''), 'GameUserSettings.ini');

// The [RememberMe] Data of an ini file, or null when it holds no login
function epicLoginOf(file) {
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const m = /^\[RememberMe\]\s*$([\s\S]*?)^Data=(.+)$/m.exec(text);
  return m && m[2].trim().length > 100 && !/^\[/m.test(m[1]) ? m[2].trim() : null;
}
async function epicCurrentId() {
  const r = await run('reg.exe', ['query', EPIC_REG, '/v', 'AccountId']);
  const m = /AccountId\s+REG_SZ\s+(\S+)/.exec(r.out);
  return m ? m[1] : null;
}
async function epicSetId(id) {
  const r = await run('reg.exe', ['add', EPIC_REG, '/v', 'AccountId', '/t', 'REG_SZ', '/d', id, '/f']);
  if (r.code !== 0) throw new Error('Kunde inte byta konto i registret.');
}
// Copy Epic's ini into the account's slot, but only when it holds a login
function epicBackup(a) {
  if (!epicLoginOf(EPIC_INI())) return false;
  fs.mkdirSync(path.dirname(epicCopy(a.id)), { recursive: true });
  fs.copyFileSync(EPIC_INI(), epicCopy(a.id));
  return true;
}
async function epicBackupCurrent() {
  const cur = await epicCurrentId();
  const a = cur && epicLoad().find(x => x.accountId === cur);
  return a ? epicBackup(a) && a : null;
}
async function epicState() {
  const list = epicLoad();
  const cur = await epicCurrentId();
  const active = list.find(a => a.accountId === cur);
  if (active) { try { epicBackup(active); } catch {} }
  return {
    installed: fs.existsSync(EPIC_INI()),
    accounts: list.map(a => ({ id: a.id, name: a.name, active: a.accountId === cur, hasLogin: !!epicLoginOf(epicCopy(a.id)) })),
    currentSaved: !!active,
    signedIn: !!cur && !!epicLoginOf(EPIC_INI())
  };
}
async function epicClose() {
  for (const exe of ['EpicGamesLauncher.exe', 'EpicWebHelper.exe']) await run('taskkill.exe', ['/IM', exe, '/F']);
  await sleep(1500);
}
async function epicExe() {
  const r = await run('reg.exe', ['query', 'HKCR\\com.epicgames.launcher\\shell\\open\\command', '/ve']);
  const m = /"([^"]+EpicGamesLauncher\.exe)"/i.exec(r.out);
  const cands = [m && m[1], 'C:\\Program Files\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe',
    'C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe'];
  return cands.find(p => p && fs.existsSync(p)) || null;
}
async function epicStart() {
  const exe = await epicExe();
  if (exe) spawn(exe, [], { detached: true, stdio: 'ignore', cwd: path.dirname(exe) }).unref();
  else shell.openExternal('com.epicgames.launcher://store');
  epicWatch();
}
// For a while after Epic starts, save every new login token it writes for a known account, and
// tell the control center when someone signs in (so a new account can be named right away).
let epicWatchTimer = null;
function epicWatch() {
  clearInterval(epicWatchTimer);
  let last = null, n = 0;
  epicWatchTimer = setInterval(async () => {
    if (++n > 90) { clearInterval(epicWatchTimer); return; }   // ~3 minutes
    const login = epicLoginOf(EPIC_INI());
    if (!login || login === last) return;
    last = login;
    const a = await epicBackupCurrent();
    if (a) log('epic login refreshed for', a.name);
    broadcast('epic-changed', null);
  }, 2000);
}
async function epicSave(name) {
  const cur = await epicCurrentId();
  if (!cur || !epicLoginOf(EPIC_INI())) throw new Error('Epic har ingen inloggning sparad. Logga in i Epic först.');
  const list = epicLoad();
  let a = list.find(x => x.accountId === cur);
  if (!a) { a = { id: crypto.randomUUID(), name: name || 'Konto ' + (list.length + 1), accountId: cur }; list.push(a); }
  else if (name) a.name = name;
  epicBackup(a);
  epicStore(list);
  log('epic saved', a.name);
}
// Close Epic, keep the login we're leaving, then either put a saved login back (switch) or leave
// Epic on its login page (add an account, or repair one whose saved login no longer works).
async function epicSwitch(id) {
  const list = epicLoad();
  const target = list.find(a => a.id === id);
  if (!target) throw new Error('Kontot finns inte längre.');
  await epicClose();
  await epicBackupCurrent();
  if (epicLoginOf(epicCopy(target.id))) {
    fs.copyFileSync(epicCopy(target.id), EPIC_INI());
    await epicSetId(target.accountId);
  } else {
    epicClearLogin();
    await epicSetId('');
  }
  await epicStart();
  log('epic switched to', target.name);
}
function epicClearLogin() {
  if (!fs.existsSync(EPIC_INI())) return;
  let sec = '';
  const out = fs.readFileSync(EPIC_INI(), 'utf8').split(/\r?\n/).filter(line => {
    const m = /^\[(.+)\]\s*$/.exec(line);
    if (m) { sec = m[1]; return true; }
    return !((sec === 'RememberMe' || sec === 'Offline') && /^Data=/.test(line));
  });
  fs.writeFileSync(EPIC_INI(), out.join('\r\n'));
}
async function epicAddNew() {
  const cur = await epicCurrentId();
  if (cur && epicLoginOf(EPIC_INI()) && !epicLoad().some(x => x.accountId === cur)) throw new Error('Spara kontot som är inloggat nu först, annars tappar du det.');
  await epicClose();
  await epicBackupCurrent();
  epicClearLogin();
  await epicSetId('');
  await epicStart();
  log('epic add-new: login cleared');
}
function epicRemove(id) {
  const list = epicLoad();
  const a = list.find(x => x.id === id);
  if (!a) return;
  try { fs.rmSync(path.dirname(epicCopy(a.id)), { recursive: true, force: true }); } catch {}
  epicStore(list.filter(x => x.id !== id));
}

/* ---------------- Weather (Open-Meteo, no key needed) ---------------- */

let lastWeather = null;
async function refreshWeather() {
  const w = settings.weather || {};
  if (w.lat == null || w.lon == null) return;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${w.lat}&longitude=${w.lon}` +
      '&current=temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m&wind_speed_unit=ms&timezone=auto';
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const c = j.current || {};
    lastWeather = { name: w.name, temp: c.temperature_2m, feels: c.apparent_temperature, code: c.weather_code, isDay: !!c.is_day, wind: c.wind_speed_10m, at: Date.now() };
    broadcast('weather', lastWeather);
  } catch (e) {
    console.error('weather', e.message);
  }
}

async function geocode(city) {
  const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=sv&format=json`);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const hit = j.results && j.results[0];
  if (!hit) return null;
  return { city, name: hit.name + (hit.admin1 && hit.admin1 !== hit.name ? ', ' + hit.admin1 : ''), lat: hit.latitude, lon: hit.longitude };
}

/* ---------------- Launcher shortcut ---------------- */

function applyShortcut() {
  globalShortcut.unregister('Alt+Space');
  if (settings.general.searchShortcut === false) return;
  try { globalShortcut.register('Alt+Space', () => toggleSpot()); } catch {}
}

/* ---------------- Spotlight-style search window ---------------- */

const SPOT_W = 600;
let spot = null;
let spotHiddenAt = 0;

function createSpot() {
  spot = new BrowserWindow({
    width: SPOT_W, height: 120,
    // The window is exactly the panel's size; glassSpot() blurs what's behind it
    frame: false, transparent: true, backgroundColor: '#00000000',
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, hasShadow: false, show: false, alwaysOnTop: true, title: 'Glimt sök',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true }
  });
  spot.setAlwaysOnTop(true, 'screen-saver');
  spot.loadFile(path.join(__dirname, 'src', 'dock.html'), { query: { spot: '1' } });
  spot.on('blur', () => hideSpot(false));
  spot.on('closed', () => { spot = null; });
}

function spotBounds(h) {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const a = d.workArea;
  return { x: Math.round(a.x + (a.width - SPOT_W) / 2), y: Math.round(a.y + a.height * 0.2), width: SPOT_W, height: Math.round(h) };
}

function toggleSpot() {
  if (!spot) createSpot();
  if (spot.isVisible()) { hideSpot(true); return; }
  spotPrev = lastWindows && lastWindows.active || 0;
  // A Win press also blurs the window; don't reopen it right after that closed it
  if (Date.now() - spotHiddenAt < 250) return;
  log('spot open');
  spot.setBounds(spotBounds(spot.getBounds().height));
  spot.show();
  glassSpot();
  spot.focus();
  spot.webContents.send('open-search');
}

// restore: give focus back to the app that was active before (Esc / Win again), but not after
// launching something or when the user clicked another window.
// Real glass for the dock: the renderer reports the dock bar and open popover as rects (CSS px,
// [x, y, w, h, radius]); the helper clips the window to them and turns on Windows' blur behind.
// Windows ignores a window region for the blur of a layered (transparent) window, so the blur
// lives in small click-through "backdrop" windows placed exactly behind the dock bar and popover.
let lastRegionRects = null, lastRegionKey = null;
const backdrops = [null, null];        // [dock bar, popover]
const backdropGlass = new Map();       // window id -> accent key last sent

function hwndOf(w) { const b = w.getNativeWindowHandle(); return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0); }

function makeBackdrop() {
  const w = new BrowserWindow({
    show: false, frame: false, transparent: true, backgroundColor: '#00000000', resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false, focusable: false, skipTaskbar: true, hasShadow: false,
    alwaysOnTop: true, title: 'Glimt glas', webPreferences: { sandbox: true, contextIsolation: true }
  });
  w.setAlwaysOnTop(true, 'screen-saver');
  w.setIgnoreMouseEvents(true);
  w.loadURL('data:text/html,<style>html,body{background:transparent;margin:0}</style>');
  w.on('closed', () => { const i = backdrops.indexOf(w); if (i >= 0) backdrops[i] = null; });
  return w;
}

function hideBackdrops() { backdrops.forEach(w => { if (w && w.isVisible()) w.hide(); }); }

function applyDockRegion() {
  lastRegionKey = null;
  const glass = settings.look.glass || 'strong';
  if (!dock || !dock.isVisible() || glass === 'off' || !Array.isArray(lastRegionRects)) { hideBackdrops(); return; }
  const db = dock.getBounds();
  const state = glass === 'light' ? 3 : 4;
  const color = settings.look.theme === 'light' ? 0x10FBF8F6 : 0x101B1410;
  let raised = false;
  for (let i = 0; i < 2; i++) {
    const r = lastRegionRects[i];
    const valid = Array.isArray(r) && r.length >= 4 && r.every(n => typeof n === 'number' && isFinite(n)) && r[2] > 4 && r[3] > 4;
    // Both are created (and shown, parked) up front: showing one later raises it above the dock,
    // and raising the dock back steals focus from an open popover, which then closes.
    if (!backdrops[i]) backdrops[i] = makeBackdrop();
    const w = backdrops[i];
    // Unused glass is parked off-screen rather than hidden: showing a window again changes the
    // z-order and focus, which would close the popover that was just opened.
    // 1 px inset so the blur never shows outside the panel's rounded border.
    const bounds = valid
      ? { x: Math.round(db.x + r[0] + 1), y: Math.round(db.y + r[1] + 1), width: Math.round(r[2] - 2), height: Math.round(r[3] - 2) }
      : { x: -32000, y: -32000, width: 10, height: 10 };
    const cur = w.getBounds();
    if (cur.x !== bounds.x || cur.y !== bounds.y || cur.width !== bounds.width || cur.height !== bounds.height) w.setBounds(bounds);
    const gk = `${state}:${color}`;
    if (backdropGlass.get(w.id) !== gk) { backdropGlass.set(w.id, gk); sendHelper({ cmd: 'glassb', hwnd: hwndOf(w), state, color }); }
    if (!w.isVisible()) { w.showInactive(); raised = true; }
  }
  if (raised) { log('glass shown, raising dock'); dock.moveTop(); }   // keep the dock's content above its glass
}

// Rounded corners + blur behind, tinted for the theme (0xAABBGGRR)
function glassSpot() {
  if (!spot) return;
  const b = spot.getNativeWindowHandle();
  const hwnd = b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0);
  sendHelper({ cmd: 'glass', hwnd, color: settings.look.theme === 'light' ? 0x50FBF8F6 : 0x401E1814 });
}

function hideSpot(restore) {
  if (!spot || !spot.isVisible()) return;
  spotHiddenAt = Date.now();
  spot.hide();
  spot.webContents.send('spot-hidden');
  if (restore && spotPrev) sendHelper({ cmd: 'focus', hwnd: spotPrev });
}
let spotPrev = 0;

/* ---------------- Win / Win+S keyboard hook ---------------- */

const HOOK_ACCEL = 'Ctrl+Alt+Shift+F20';  // what glimt-keys.ps1 sends when it takes over a Win press
let keys = null;
let keysWanted = '';

function applyWinKeys() {
  const g = settings.general;
  const want = g.winKey || g.winS ? `${g.winKey ? 1 : 0}${g.winS ? 1 : 0}` : '';
  if (want === keysWanted && (keys || !want)) return;
  keysWanted = want;
  if (keys) { const k = keys; keys = null; try { k.kill(); } catch {} }
  globalShortcut.unregister(HOOK_ACCEL);
  if (!want) return;
  try { globalShortcut.register(HOOK_ACCEL, () => toggleSpot()); } catch (e) { log('hook accel register failed', e.message); }
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(__dirname, 'helper', 'glimt-keys.ps1').replace('app.asar', 'app.asar.unpacked'),
    '-WinAlone', want[0], '-WinS', want[1]], { windowsHide: true });
  keys = p;
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', d => log('[keys]', String(d).trim()));
  p.stderr.on('data', d => log('[keys] err', String(d).trim()));
  p.on('exit', code => {
    if (keys !== p) return;
    keys = null;
    log('[keys] exit', code);
    if (!quitting) setTimeout(() => { keysWanted = ''; applyWinKeys(); }, 5000);
  });
}

function sendHelper(obj) {
  if (helper && helper.stdin.writable) helper.stdin.write(JSON.stringify(obj) + '\n');
}

function onHelperMessage(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'media') {
    if (msg.art) { art.key = msg.trackKey; art.data = msg.art; }
    else if (msg.trackKey && msg.trackKey === art.key) msg.art = art.data;
    lastMedia = msg;
    broadcast('media', msg);
  } else if (msg.type === 'stats') {
    lastStats = msg;
    broadcast('stats', msg);
  } else if (msg.type === 'fullscreen') {
    onFullscreen(!!msg.value);
  } else if (msg.type === 'bluetooth') {
    if (lastStats) lastStats.bluetooth = msg.state;
    broadcast('bluetooth', msg.state);
  } else if (msg.type === 'mixer') {
    broadcast('mixer', msg);
  } else if (msg.type === 'search') {
    broadcast('search-results', msg);
  } else if (msg.type === 'startapps') {
    startApps = msg.list || [];
    buildAppIndex();
  } else if (msg.type === 'windows') {
    lastWindows = msg;
    broadcast('windows', msg);
  } else if (msg.type === 'taskbar') {
    if (!lastTaskbar || lastTaskbar.autoHide !== msg.autoHide || lastTaskbar.hidden !== msg.hidden) broadcast('taskbar', msg);
    lastTaskbar = msg;
  } else if (msg.type === 'ready') {
    console.log('[helper] ready', JSON.stringify(msg));
    initHelper();
  } else if (msg.type === 'error') {
    console.error('[helper]', msg.scope, msg.message);
  }
}

function onFullscreen(isFs) {
  if (!dock) return;
  if (isFs && settings.general.hideFullscreen && dock.isVisible()) {
    hiddenForFullscreen = true; dock.hide();
  } else if (!isFs && hiddenForFullscreen) {
    hiddenForFullscreen = false; dock.showInactive();
  }
}

/* ---------------- CPU / RAM / disk ---------------- */

let prevCpu = os.cpus();
const cpuModel = (prevCpu[0] && prevCpu[0].model || '').replace(/\s+/g, ' ').trim();
let lastSys = null;
let disks = [];

function sampleCpu() {
  const cur = os.cpus();
  const cores = cur.map((c, i) => {
    const p = prevCpu[i] || c;
    const idle = c.times.idle - p.times.idle;
    const total = Object.values(c.times).reduce((a, b) => a + b, 0) - Object.values(p.times).reduce((a, b) => a + b, 0);
    return total > 0 ? Math.max(0, Math.min(100, 100 * (1 - idle / total))) : 0;
  });
  prevCpu = cur;
  const total = os.totalmem(), free = os.freemem();
  lastSys = {
    cpu: cores.reduce((a, b) => a + b, 0) / (cores.length || 1),
    cores,
    cpuModel,
    speed: cur[0] ? cur[0].speed : 0,
    memTotal: total,
    memUsed: total - free,
    uptime: os.uptime(),
    disks
  };
  broadcast('sys', lastSys);
}

async function sampleDisks() {
  const out = [];
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = letter + ':\\';
    try {
      const s = await fs.promises.statfs(root);
      const total = s.blocks * s.bsize;
      if (total > 0) out.push({ name: letter + ':', total, free: s.bavail * s.bsize });
    } catch {}
  }
  disks = out;
}

/* ---------------- IPC ---------------- */

const iconCache = new Map();
const targetCache = new Map();

// The .exe a pinned item really runs, so it can be matched against open windows.
function resolveTarget(p) {
  if (targetCache.has(p)) return targetCache.get(p);
  let t = p;
  if (/\.lnk$/i.test(p)) { try { t = shell.readShortcutLink(p).target || p; } catch {} }
  t = String(t).toLowerCase();
  targetCache.set(p, t);
  return t;
}

function updateApps(apps) {
  settings.apps = apps;
  saveSettings();
  broadcast('settings', settings);
}

function registerIpc() {
  ipcMain.handle('get-settings', () => settings);
  ipcMain.handle('get-state', () => ({ media: lastMedia, stats: lastStats, sys: lastSys, windows: lastWindows, taskbar: lastTaskbar, weather: lastWeather, apps: appIndex }));

  // ---- Taskbar replacement: windows, Start, shortcuts ----
  ipcMain.on('win-click', (e, hwnd) => sendHelper({ cmd: 'click', hwnd }));
  ipcMain.on('win-focus', (e, hwnd) => sendHelper({ cmd: 'focus', hwnd }));
  const KEYS = { start: [0x5B], notifications: [0x5B, 0x4E], quick: [0x5B, 0x41], desktop: [0x5B, 0x44], tasks: [0x5B, 0x09] };
  ipcMain.on('shell-keys', (e, name) => { if (KEYS[name]) sendHelper({ cmd: 'keys', keys: KEYS[name] }); });
  ipcMain.on('open-taskbar-settings', () => shell.openExternal('ms-settings:taskbar'));

  ipcMain.handle('app-target', (e, p) => resolveTarget(p));

  // ---- Launcher / search ----
  ipcMain.handle('get-apps', () => appIndex);
  ipcMain.on('search-files', (e, q) => {
    if (q && typeof q.q === 'string' && q.q.trim().length >= 2) sendHelper({ cmd: 'search', q: q.q.trim().slice(0, 100), id: q.id });
  });
  ipcMain.on('open-item', (e, it) => {
    if (!it) return;
    if ((it.kind === 'lnk' || it.kind === 'file') && it.path) shell.openPath(it.path);
    else if (it.kind === 'uwp' && it.id) spawn('explorer.exe', ['shell:AppsFolder\\' + it.id], { detached: true, stdio: 'ignore' }).unref();
    else if (it.kind === 'reveal' && it.path) shell.showItemInFolder(it.path);
    else if (it.kind === 'uri' && /^(ms-settings:|https:\/\/www\.google\.com\/search\?)/.test(it.uri || '')) shell.openExternal(it.uri);
    else if (it.kind === 'glimt') openSettings(it.tab);
  });

  // ---- Bluetooth ----
  ipcMain.on('bluetooth', (e, on) => sendHelper({ cmd: 'bluetooth', on: !!on }));

  // ---- Control center ----
  const MIXER_CMDS = ['mixer', 'appvol', 'appmute', 'output', 'micmute', 'wifi'];
  ipcMain.on('mixer-cmd', (e, c) => {
    if (!c || !MIXER_CMDS.includes(c.cmd)) return;
    sendHelper({ cmd: c.cmd, key: c.key != null ? String(c.key) : undefined, id: c.id != null ? String(c.id) : undefined,
      value: typeof c.value === 'number' ? c.value : undefined, on: !!c.on });
  });
  ipcMain.handle('epic', async (e, c) => {
    try {
      if (c && c.cmd === 'save') await epicSave(String(c.name || '').trim().slice(0, 40));
      else if (c && c.cmd === 'switch') await epicSwitch(String(c.id || ''));
      else if (c && c.cmd === 'remove') epicRemove(String(c.id || ''));
      else if (c && c.cmd === 'addnew') await epicAddNew();
      return await epicState();
    } catch (err) {
      log('epic', c && c.cmd, err.message);
      return { ...(await epicState()), error: err.message };
    }
  });
  ipcMain.on('cc-action', async (e, name) => {
    if (name === 'shutdown' || name === 'restart') {
      // Full shutdown/restart (not fast-startup hibernation); logged so a wrong outcome can be traced
      const r = await run('shutdown.exe', [name === 'shutdown' ? '/s' : '/r', '/t', '0']);
      log('power', name, 'exit', r.code);
    }
    else if (name === 'display') shell.openExternal('ms-settings:display');
    else if (name === 'mixerSettings') shell.openExternal('ms-settings:apps-volume');
    else if (name === 'network') shell.openExternal('ms-settings:network');
    else if (name === 'bluetoothSettings') shell.openExternal('ms-settings:bluetooth');
  });

  // ---- Weather ----
  ipcMain.handle('get-weather', () => lastWeather);
  ipcMain.handle('set-weather-city', async (e, city) => {
    try {
      const g = await geocode(String(city || '').trim());
      if (!g) return { ok: false, error: 'Hittade ingen ort som heter så.' };
      settings.weather = g; saveSettings();
      broadcast('settings', settings);
      await refreshWeather();
      return { ok: true, name: g.name };
    } catch (err) {
      return { ok: false, error: 'Kunde inte nå vädertjänsten. Kontrollera internetanslutningen.' };
    }
  });

  ipcMain.on('app-menu', (e, info) => {
    const items = [];
    if (info.path) items.push({ label: 'Öppna ' + (info.name || 'programmet'), click: () => shell.openPath(info.path) });
    (info.windows || []).forEach(w => items.push({ label: (w.title || 'Fönster').slice(0, 60), click: () => sendHelper({ cmd: 'focus', hwnd: w.hwnd }) }));
    if (items.length) items.push({ type: 'separator' });
    if (info.pinned) {
      items.push({ label: 'Lossa från dockan', click: () => updateApps(settings.apps.filter(a => a.path !== info.path)) });
    } else if (info.path) {
      items.push({ label: 'Fäst i dockan', click: () => updateApps(settings.apps.concat([{ name: info.name, path: info.path }])) });
    }
    if ((info.windows || []).length) {
      items.push({ label: info.windows.length > 1 ? `Stäng alla ${info.windows.length} fönster` : 'Stäng fönstret',
        click: () => info.windows.forEach(w => sendHelper({ cmd: 'close', hwnd: w.hwnd })) });
    }
    Menu.buildFromTemplate(items).popup({ window: dock });
  });

  ipcMain.handle('set-settings', (e, patch) => {
    settings = merge(settings, patch);
    saveSettings();
    if (patch.general || (patch.look && ['position', 'scale', 'margin'].some(k => k in patch.look))) applyWindowSettings();
    if (patch.look && ('glass' in patch.look || 'theme' in patch.look)) applyDockRegion();
    if (patch.general && 'searchShortcut' in patch.general) applyShortcut();
    if (patch.general && ('winKey' in patch.general || 'winS' in patch.general)) applyWinKeys();
    if (patch.general && 'startWithWindows' in patch.general) applyAutostart();
    if (patch.media && 'source' in patch.media) sendHelper({ cmd: 'source', id: patch.media.source });
    if (patch.look && 'theme' in patch.look && settingsWin) {
      const light = settings.look.theme === 'light';
      try {
        settingsWin.setTitleBarOverlay({ color: light ? '#f3f5f8' : '#0f1319', symbolColor: light ? '#1b2330' : '#e8edf2' });
        settingsWin.setBackgroundColor(light ? '#f3f5f8' : '#0f1319');
      } catch {}
    }
    broadcast('settings', settings);
    return settings;
  });

  ipcMain.handle('reset-look', () => {
    settings.look = { ...DEFAULTS.look };
    saveSettings(); applyWindowSettings();
    broadcast('settings', settings);
    return settings;
  });

  ipcMain.on('set-ignore', (e, ignore) => {
    if (dock && !dock.isDestroyed()) dock.setIgnoreMouseEvents(!!ignore, { forward: true });
  });
  ipcMain.on('dock-focus', () => { if (dock) dock.focus(); });
  ipcMain.on('dock-region', (e, rects) => { lastRegionRects = rects; applyDockRegion(); });
  ipcMain.on('spot-hide',(e, restore) => hideSpot(!!restore));
  ipcMain.on('spot-open', () => toggleSpot());
  ipcMain.on('spot-size', (e, h) => {
    if (!spot || typeof h !== 'number') return;
    const b = spot.getBounds();
    const nh = Math.max(80, Math.min(Math.ceil(h), 800));
    if (nh !== b.height) spot.setBounds({ ...b, height: nh });
  });
  ipcMain.on('media-cmd', (e, cmd) => sendHelper(cmd));
  ipcMain.on('open-settings', (e, tab) => openSettings(tab));
  ipcMain.on('dock-menu', () => {
    Menu.buildFromTemplate(menuTemplate()).popup({ window: dock });
  });
  ipcMain.on('launch', (e, p) => { if (typeof p === 'string' && p) shell.openPath(p); });
  ipcMain.on('open-source-app', (e, id) => {
    if (/spotify/i.test(id || '')) shell.openExternal('spotify:');
  });
  ipcMain.on('quit', () => app.quit());

  ipcMain.handle('pick-app', async () => {
    const r = await dialog.showOpenDialog(settingsWin || undefined, {
      title: 'Välj ett program',
      defaultPath: path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      filters: [{ name: 'Program och genvägar', extensions: ['exe', 'lnk', 'url', 'bat', 'cmd'] }],
      properties: ['openFile']
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const p = r.filePaths[0];
    return { name: path.basename(p).replace(/\.(exe|lnk|url|bat|cmd)$/i, ''), path: p };
  });

  ipcMain.handle('app-icon', async (e, p) => {
    if (iconCache.has(p)) return iconCache.get(p);
    let target = p;
    if (/\.lnk$/i.test(p)) {
      try {
        const link = shell.readShortcutLink(p);
        target = link.icon && fs.existsSync(link.icon) ? link.icon : (link.target || p);
      } catch {}
    }
    let data = null;
    try { data = (await app.getFileIcon(target, { size: 'large' })).toDataURL(); } catch {}
    iconCache.set(p, data);
    return data;
  });
}

/* ---------------- Dev: screenshots for checking the UI ---------------- */

async function devScreenshots(dir) {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async (win, name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(dir, name + '.png'), img.toPNG());
  };
  fs.mkdirSync(dir, { recursive: true });
  await wait(6000);
  await shot(dock, 'dock');
  await dock.webContents.executeJavaScript(`document.querySelector('.w[data-id="search"]')?.click()`);
  await wait(1200);
  await shot(dock, 'dock-start');
  await dock.webContents.executeJavaScript(`(() => { const i = document.querySelector('#lq'); i.value = 'spo'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await wait(2500);
  await shot(dock, 'dock-search');
  await dock.webContents.executeJavaScript(`(() => { const i = document.querySelector('#lq'); i.value = '12*3,5+1'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await wait(800);
  await shot(dock, 'dock-calc');
  await dock.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
  for (const t of ['general']) {
    openSettings(t);
    await wait(1500);
    await shot(settingsWin, 'settings-' + t);
  }
  console.log('[shots] done');
}

/* ---------------- Lifecycle ---------------- */

if (process.argv.includes('--make-icon')) {
  // Build step: writes the app icon (same drawing as the tray icon) for the installer
  app.whenReady().then(() => {
    fs.mkdirSync(path.join(__dirname, 'build'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, 'build', 'icon.png'), trayImage(256).toPNG());
    app.quit();
  });
} else if (!app.requestSingleInstanceLock()) {
  log('another instance is running; quitting');
  app.quit();
} else {
  app.on('child-process-gone', (e, d) => log('child-process-gone', d));
  app.on('render-process-gone', (e, wc, d) => log('render-process-gone', d));
  app.on('quit', (e, code) => log('quit', code));
  app.on('second-instance', () => openSettings());

  app.whenReady().then(async () => {
    loadSettings();
    registerIpc();
    await sampleDisks();
    createDock();
    createTray();
    startHelper();
    scanStartMenu();
    applyShortcut();
    createSpot();
    applyWinKeys();
    applyAutostart();
    // At login Explorer's taskbar may not exist yet when Glimt starts: hide/reserve again a bit later
    setTimeout(() => { lastTaskbarKey = null; applyTaskbar(); }, 15000);
    refreshWeather();
    setInterval(refreshWeather, 15 * 60 * 1000);
    setInterval(sampleCpu, 1000);
    setInterval(sampleDisks, 30000);
    screen.on('display-metrics-changed', applyWindowSettings);
    screen.on('display-added', applyWindowSettings);
    screen.on('display-removed', applyWindowSettings);
    if (!fs.existsSync(settingsFile())) { saveSettings(); openSettings('welcome'); }
    if (process.env.GLIMT_SHOT) devScreenshots(process.env.GLIMT_SHOT);
  });

  app.on('window-all-closed', e => { /* keep running in the tray */ });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('before-quit', () => {
    quitting = true;
    if (keys) { try { keys.kill(); } catch {} }
    // Give the taskbar back. Closing stdin makes the helper restore it and exit on its own,
    // so it must not be killed here.
    if (helper) { try { sendHelper({ cmd: 'taskbar', hide: false }); helper.stdin.end(); } catch {} }
  });
}
