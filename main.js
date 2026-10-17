const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, globalShortcut, ipcMain, shell } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const https = require('https');
const path = require('path');
const { pathToFileURL } = require('url');
const { execFile, spawn } = require('child_process');
const MusicModel = require('./renderer/music-model');

// Local preview keeps the installed application, mappings and shortcut intact.
const AUDIO_PREVIEW = process.argv.includes('--audio-preview');
if (AUDIO_PREVIEW) {
  const original = path.join(app.getPath('appData'), 'champion-soundboard', 'settings.json');
  const previewDirectory = path.join(app.getPath('appData'), 'lbgm-internal-preview');
  app.setName('LBGM 内部混音测试版');
  app.setPath('userData', previewDirectory);
  const target = path.join(previewDirectory, 'settings.json');
  if (!fs.existsSync(target)) {
    let source = {}; try { source = JSON.parse(fs.readFileSync(original, 'utf8')); } catch { /* new user */ }
    source = { ...source, audioBackend: 'internal', setupDone: false, internalMicDeviceName: source.microphoneDeviceName || '', cableOutputDeviceName: 'CABLE Input (VB-Audio Virtual Cable)', internalMicGainDb: 0, internalWeakNetworkMode: false, internalLoudnessStabilizer: false };
    fs.mkdirSync(previewDirectory, { recursive: true });
    fs.writeFileSync(target, JSON.stringify(source, null, 2));
  }
}

// Playback is intentionally initiated by a trusted local global hotkey rather
// than a click inside the renderer, so do not let Chromium's autoplay policy
// reject it after a fresh app launch.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// 内存优先：界面是纯静态卡片（无视频/Canvas/动画），软件渲染足够，
// 禁用硬件加速可省掉独立 GPU 进程的大部分开销（约 20-50MB）。
app.disableHardwareAcceleration();
// 关闭用不到的 Chromium 特性，进一步压缩常驻内存。
app.commandLine.appendSwitch('disable-features', 'Translate,BackForwardCache,MediaRouter,OptimizationHints');

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

let win;
let tray;
const DEFAULT_PLAY_HOTKEYS = ['Ctrl+1', 'Ctrl+2', 'Ctrl+3'];
const RESTART_HOTKEY = 'Ctrl+4';
// V1.1 preserves existing bindings, including the original Shift+1/2/3.
// One Ctrl/Shift modifier (or both) plus a letter, digit or F1~F24. Alt is not
// offered because the native game helper cannot read it.
const HOTKEY_PATTERN = /^(?:(?:Ctrl\+Shift|Shift\+Ctrl|Ctrl|Shift)\+)(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4]))$/;
const DEFAULT_MUSIC_VOLUME = 0.13;
// Physical devices are chosen explicitly; Windows defaults stay untouched.
const DEFAULT_HEADPHONE_NAME = '';
const DEFAULT_MICROPHONE_NAME = '';
let config = MusicModel.migrate({ playHotkeys: [...DEFAULT_PLAY_HOTKEYS], pauseHotkey: 'Ctrl+A', musicVolume: DEFAULT_MUSIC_VOLUME, weakNetworkMode: true, loudnessStabilizer: false, calibrationInputDeviceId: '', mappings: {}, lockfilePath: '', outputDeviceId: '', monitorDeviceId: '', headphoneDeviceName: DEFAULT_HEADPHONE_NAME, microphoneDeviceName: DEFAULT_MICROPHONE_NAME, manualChampion: '', closeAction: '', setupDone: false });
let lcuTimer;
let lcuPollInFlight = false;
let lastProcessLockCheckAt = 0;
let lastChampion = null;
let hotkeyHelper = null;
let hotkeyPollTimer = null;
let lastHotkeyEventId = null;
let quitting = false;
let lastPlayTriggerAt = 0;
let lastPauseTriggerAt = 0;
let lastRestartTriggerAt = 0;
let hotkeyCapture = null;
let closeConfirmInFlight = false;
// Champion detection polls every second; the id→name list is cached in memory
// so a poll tick never refetches or rewrites the champion list files.
const CHAMPION_LIST_TTL_MS = 5 * 60 * 1000;
const CHAMPION_CACHE_FALLBACK_TTL_MS = 10 * 1000;
let championListCache = null;
let championCacheSnapshot = '';
let championStatusSnapshot = '';
let lcuStatusSnapshot = '';
let championSnapshot = '';
let currentLcuStatus = null;
let lastUnknownChampionRefreshAt = 0;
// LCU discovery bookkeeping (also mirrored into lcu-discovery-status.json).
let appElevated = null; // null = check still running
let discoveryState = { clientProcesses: [], riotPids: [], processLock: null, lockfileLocks: 0, lastError: '' };
let discoveryStatusSnapshot = '';

function configPath() { return path.join(app.getPath('userData'), 'settings.json'); }
// 打包后 C# 辅助与 PowerShell 脚本位于安装目录 resources/scripts；开发时在项目 scripts/。
const scriptsDir = () => path.join(app.isPackaged ? process.resourcesPath : __dirname, 'scripts');
function validateHotkeys(playHotkeys, pauseHotkey) {
  const accelerators = Array.isArray(playHotkeys) ? playHotkeys.map(value => String(value ?? '')) : [];
  if (accelerators.length !== 3 || accelerators.some(value => !HOTKEY_PATTERN.test(value))) {
    return { ok: false, error: '播放键必须是 Ctrl 或 Shift（可叠加）加字母、数字或 F1~F24。' };
  }
  if (!HOTKEY_PATTERN.test(String(pauseHotkey ?? ''))) {
    return { ok: false, error: '暂停键必须是 Ctrl 或 Shift（可叠加）加字母、数字或 F1~F24。' };
  }
  const combined = [...accelerators, String(pauseHotkey)].map(value => value.toUpperCase());
  if (combined.includes(RESTART_HOTKEY.toUpperCase())) return { ok: false, error: 'Ctrl+4 已保留用于从头播放当前 BGM。' };
  if (new Set(combined).size !== combined.length) return { ok: false, error: '四个快捷键之间不能重复。' };
  return { ok: true, playHotkeys: accelerators, pauseHotkey: String(pauseHotkey) };
}
async function loadConfig() {
  let migrated = false;
  try {
    const stored = JSON.parse(await fsp.readFile(configPath(), 'utf8'));
    // Preserve the original user library before introducing V1.1 fields.
    const backupPath = path.join(app.getPath('userData'), 'settings.before-v1.1.json');
    if (!fs.existsSync(backupPath)) await fsp.copyFile(configPath(), backupPath);
    config = { ...config, ...stored, playHotkeys: DEFAULT_PLAY_HOTKEYS };
    if ('hotkey' in config) { delete config.hotkey; migrated = true; }
    const storedPlay = Array.isArray(stored.playHotkeys) ? stored.playHotkeys.map(value => String(value ?? '')) : null;
    if (storedPlay && storedPlay.length === 3 && storedPlay.every(value => HOTKEY_PATTERN.test(value))) {
      config.playHotkeys = storedPlay;
    }
    if (!HOTKEY_PATTERN.test(String(config.pauseHotkey ?? ''))) { config.pauseHotkey = 'Ctrl+A'; migrated = true; }
    if (!['', 'tray', 'exit'].includes(config.closeAction)) { config.closeAction = ''; migrated = true; }
    // 手动指定英雄仅本次运行有效：每次启动都恢复自动检测，
    // 避免上次的手动选择悄悄影响之后的对局。
    config.manualChampion = '';
    for (const field of ['headphoneDeviceName', 'microphoneDeviceName']) {
      const name = MusicModel.deviceName(config[field]);
      if (name !== config[field]) { config[field] = name; migrated = true; }
    }
    if (new Set([...config.playHotkeys, config.pauseHotkey].map(value => value.toUpperCase())).size !== 4) {
      config.playHotkeys = [...DEFAULT_PLAY_HOTKEYS];
      config.pauseHotkey = 'Ctrl+A';
      migrated = true;
    }
    // A pre-V1.1 custom Ctrl+4 binding must not fire both play and restart.
    const bindings = [...config.playHotkeys, config.pauseHotkey];
    for (let index = 0; index < bindings.length; index++) {
      if (bindings[index].toUpperCase() !== RESTART_HOTKEY.toUpperCase()) continue;
      bindings[index] = Array.from({ length: 24 }, (_, i) => `Ctrl+F${i + 1}`).find(candidate => !bindings.some(value => value.toUpperCase() === candidate.toUpperCase()));
      migrated = true;
    }
    config.playHotkeys = bindings.slice(0, 3);
    config.pauseHotkey = bindings[3];
    const mappings = {};
    for (const [champion, value] of Object.entries(config.mappings || {})) {
      if (Array.isArray(value)) {
        mappings[champion] = [value[0] || null, value[1] || null, value[2] || null];
      } else if (value && typeof value === 'object') {
        // Legacy single-track mappings become slot 1 without losing anything.
        mappings[champion] = [value, null, null];
        migrated = true;
      }
    }
    config.mappings = mappings;
    config.monitorVolume = Number.isFinite(stored.monitorVolume) ? stored.monitorVolume : (Number.isFinite(stored.musicVolume) ? stored.musicVolume : DEFAULT_MUSIC_VOLUME);
    if (stored.audioBackend !== 'internal') migrated = true;
    config = MusicModel.migrate({ ...config, audioBackend: stored.audioBackend });
    if (!Array.isArray(stored.publicTracks) || !Number.isFinite(stored.monitorVolume) || !Array.isArray(stored.recentChampions)) migrated = true;
    if (typeof stored.weakNetworkMode !== 'boolean') {
      config.weakNetworkMode = true;
      migrated = true;
    }
    if (typeof stored.loudnessStabilizer !== 'boolean') {
      config.loudnessStabilizer = false;
      migrated = true;
    }
    if (typeof stored.setupDone !== 'boolean') {
      config.setupDone = false;
      migrated = true;
    }
    if (!Number.isFinite(stored.musicVolume)) {
      config.musicVolume = DEFAULT_MUSIC_VOLUME;
      migrated = true;
    }
    if (migrated) await saveConfig();
  } catch { /* first run */ }
}
let configWriteQueue = Promise.resolve();
function saveConfig() {
  const snapshot = JSON.stringify(config, null, 2);
  const operation = configWriteQueue.catch(() => {}).then(async () => {
    await fsp.mkdir(path.dirname(configPath()), { recursive: true });
    const temporary = `${configPath()}.tmp`;
    await fsp.writeFile(temporary, snapshot, 'utf8');
    await fsp.rename(temporary, configPath());
  });
  configWriteQueue = operation;
  return operation;
}
function serializableConfig() {
  return { ...MusicModel.migrate(config), audioPreview: AUDIO_PREVIEW, previewBuild: AUDIO_PREVIEW ? '2026.10.17' : '', testTrackUrl: pathToFileURL(ensureTestTrack()).href };
}

function ensureDesktopShortcut() {
  const script = path.join(scriptsDir(), 'ensure-shortcut.ps1');
  // 打包后目标是安装的 exe 本体；开发模式指向项目内 Electron 并带项目参数。
  const extra = app.isPackaged ? [] : ['-Arguments', `"${__dirname}"`];
  const iconPath = app.isPackaged ? process.execPath : path.join(__dirname, 'renderer', 'app.ico');
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-TargetPath', process.execPath, ...extra, '-IconPath', iconPath],
      { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 32 }, (error, stdout, stderr) => {
        const status = { ok: !error, checkedAt: new Date().toISOString(), output: stdout.trim(), error: error ? (stderr.trim() || error.message) : '' };
        try { fs.writeFileSync(path.join(app.getPath('userData'), 'shortcut-file-status.json'), JSON.stringify(status, null, 2)); } catch { /* diagnostics only */ }
        resolve(status);
      });
  });
}

function ensureTestTrack() {
  const target = path.join(app.getPath('userData'), 'test-tone.wav');
  if (fs.existsSync(target)) return target;
  const rate = 44100, seconds = 1.2, frames = Math.floor(rate * seconds);
  const data = Buffer.alloc(44 + frames * 2);
  data.write('RIFF', 0); data.writeUInt32LE(36 + frames * 2, 4); data.write('WAVE', 8);
  data.write('fmt ', 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) {
    const env = Math.min(1, i / 500) * Math.min(1, (frames - i) / 1200);
    data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 523.25 * i / rate) * 0.28 * env * 32767), 44 + i * 2);
  }
  fs.writeFileSync(target, data);
  return target;
}

function emit(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }
function emitLcuStatus(status, force = false) {
  currentLcuStatus = status;
  const snapshot = `${status.connected ? '1' : '0'}|${status.text}`;
  if (!force && snapshot === lcuStatusSnapshot) return;
  lcuStatusSnapshot = snapshot;
  emit('lcu-status', status);
}
function emitChampion(champion, force = false) {
  const snapshot = JSON.stringify(champion);
  if (!force && snapshot === championSnapshot) return;
  championSnapshot = snapshot;
  emit('champion-detected', champion);
}
// The renderer registers its listeners some time after launch; without a
// replay it would miss the first (deduplicated) status forever.
function replayRendererState() {
  if (currentLcuStatus) emit('lcu-status', currentLcuStatus);
  if (lastChampion) emit('champion-detected', lastChampion);
}
function checkElevated() {
  // `net session` only succeeds from an elevated process. Checked once; the
  // result feeds the UI hint and lcu-discovery-status.json.
  execFile('net.exe', ['session'], { windowsHide: true, timeout: 5000 }, error => {
    appElevated = !error;
    recordDiscoveryStatus();
  });
}
function recordDiscoveryStatus() {
  const payload = {
    checkedAt: new Date().toISOString(),
    appElevated,
    clientProcesses: discoveryState.clientProcesses,
    riotPids: discoveryState.riotPids,
    processLockPort: discoveryState.processLock?.port || null,
    lockfileLocks: discoveryState.lockfileLocks,
    lastError: discoveryState.lastError
  };
  const snapshot = JSON.stringify(payload);
  if (snapshot === discoveryStatusSnapshot) return;
  discoveryStatusSnapshot = snapshot;
  try { fs.writeFileSync(path.join(app.getPath('userData'), 'lcu-discovery-status.json'), JSON.stringify(payload, null, 2)); } catch { /* diagnostics only */ }
}
function triggerPlayback(slot, accelerator) {
  if (hotkeyCapture) return; // rebinding in progress: keys belong to the capture UI
  const now = Date.now();
  if (now - lastPlayTriggerAt < 250) return;
  lastPlayTriggerAt = now;
  try {
    fs.writeFileSync(path.join(app.getPath('userData'), 'playback-command.json'), JSON.stringify({ accelerator, slot, champion: lastChampion, triggeredAt: new Date().toISOString() }, null, 2));
  } catch { /* diagnostics must never affect playback */ }
  emit('toggle-playback', { slot });
}
function triggerPause() {
  if (hotkeyCapture) return;
  const now = Date.now();
  if (now - lastPauseTriggerAt < 250) return;
  lastPauseTriggerAt = now;
  emit('pause-playback');
}
function recordShortcutStatus(accelerator, result) {
  try {
    fs.writeFileSync(path.join(app.getPath('userData'), 'shortcut-status.json'), JSON.stringify({ accelerator, ...result, checkedAt: new Date().toISOString() }, null, 2));
  } catch { /* diagnostics must never affect playback */ }
}
function triggerRestart() {
  if (hotkeyCapture || Date.now() - lastRestartTriggerAt < 250) return;
  lastRestartTriggerAt = Date.now();
  emit('restart-playback');
}
function setShortcuts(playAccelerators, pauseAccelerator) {
  globalShortcut.unregisterAll();
  const accelerators = Array.isArray(playAccelerators) ? playAccelerators : DEFAULT_PLAY_HOTKEYS;
  const helperActive = Boolean(hotkeyHelper && hotkeyHelper.exitCode === null);
  const playResults = accelerators.map((accelerator, slot) => globalShortcut.register(accelerator, () => triggerPlayback(slot, accelerator)));
  const pauseOk = pauseAccelerator && globalShortcut.register(pauseAccelerator, triggerPause);
  const restartOk = globalShortcut.register(RESTART_HOTKEY, triggerRestart);
  const failed = [];
  playResults.forEach((ok, slot) => { if (!ok && !helperActive) failed.push(`播放键 ${accelerators[slot]}`); });
  if (!pauseOk && !helperActive) failed.push(`暂停键 ${pauseAccelerator}`);
  if (!restartOk && !helperActive) failed.push(`重播键 ${RESTART_HOTKEY}`);
  const result = failed.length === 0
    ? { ok: true, playOk: playResults.map(ok => ok || helperActive), pauseOk: Boolean(pauseOk) || helperActive, mode: helperActive ? 'elevated-key-state+global-fallback' : 'global-shortcut' }
    : { ok: false, playOk: playResults, pauseOk: Boolean(pauseOk), mode: 'global-shortcut', error: `${failed.join('、')} 无效或已被其他程序占用。` };
  recordShortcutStatus(`${accelerators.join(' / ')} / ${pauseAccelerator}`, result);
  return result;
}

function startGameHotkeyHelper(playAccelerators, pauseAccelerator) {
  if (hotkeyPollTimer) { clearInterval(hotkeyPollTimer); hotkeyPollTimer = null; }
  if (hotkeyHelper && hotkeyHelper.exitCode === null) hotkeyHelper.kill();
  hotkeyHelper = null;
  const accelerators = Array.isArray(playAccelerators) ? playAccelerators : DEFAULT_PLAY_HOTKEYS;
  if (accelerators.length !== 3 || accelerators.some(value => !HOTKEY_PATTERN.test(String(value ?? ''))) || !HOTKEY_PATTERN.test(String(pauseAccelerator ?? ''))) return false;
  const helper = path.join(scriptsDir(), 'GameHotkeyStateHelperV2.exe');
  if (!fs.existsSync(helper)) return false;
  const eventFile = path.join(app.getPath('userData'), 'game-hotkey-event.json');
  const readyFile = path.join(app.getPath('userData'), 'game-hotkey-ready.txt');
  try { fs.rmSync(eventFile, { force: true }); } catch { /* stale event only */ }
  try { fs.rmSync(readyFile, { force: true }); } catch { /* stale diagnostic only */ }
  lastHotkeyEventId = null;
  const child = spawn(helper, [String(process.pid), eventFile, readyFile, ...accelerators, pauseAccelerator, RESTART_HOTKEY], { windowsHide: true, stdio: 'ignore' });
  hotkeyHelper = child;
  child.on('error', () => {
    if (hotkeyHelper !== child) return;
    hotkeyHelper = null;
    if (!quitting) setShortcuts(config.playHotkeys, config.pauseHotkey);
  });
  child.on('exit', () => {
    if (hotkeyHelper !== child) return;
    hotkeyHelper = null;
    if (!quitting) setShortcuts(config.playHotkeys, config.pauseHotkey);
  });
  hotkeyPollTimer = setInterval(() => {
    try {
      const event = JSON.parse(fs.readFileSync(eventFile, 'utf8'));
      if (!event.id || event.id === lastHotkeyEventId) return;
      lastHotkeyEventId = event.id;
      // While rebinding, consume native helper events without acting on them so
      // the pressed keys reach the capture UI instead of starting playback.
      if (hotkeyCapture) return;
      if (event.type === 'play') {
        const slot = Math.max(0, Math.min(2, Number(event.slot) || 0));
        triggerPlayback(slot, accelerators[slot]);
      }
      else if (event.type === 'pause') triggerPause();
      else if (event.type === 'restart') triggerRestart();
    } catch { /* no new complete event */ }
  }, 60);
  return true;
}

function candidateLockfiles() {
  const roots = [
    config.lockfilePath && path.dirname(config.lockfilePath),
    process.env.RIOT_GAMES_PATH,
    'C:\\Riot Games\\League of Legends',
    'C:\\Program Files\\Riot Games\\League of Legends',
    'C:\\Program Files (x86)\\Riot Games\\League of Legends',
    'D:\\Riot Games\\League of Legends',
    'D:\\Program Files\\Riot Games\\League of Legends',
    'E:\\Riot Games\\League of Legends',
    'E:\\Program Files\\Riot Games\\League of Legends',
    // WeGame's current League client keeps the live LCU lockfile here.
    'D:\\WeGameApps\\英雄联盟\\Riot Client Data\\User Data\\Config'
  ].filter(Boolean);
  return [...new Set(roots.map(root => path.join(root, 'lockfile')))];
}
function readLockfiles() {
  const locks = [];
  for (const file of candidateLockfiles()) {
    try {
      const [name, pid, port, password, protocol] = fs.readFileSync(file, 'utf8').trim().split(':');
      if (name && pid && port && password && protocol) locks.push({ pid: Number(pid), port, password, protocol, file });
    } catch { /* client is not installed or not running */ }
  }
  return locks;
}
function pidAlive(pid) {
  try { return Number.isInteger(pid) && pid > 0 && process.kill(pid, 0); }
  catch (error) { return error.code === 'EPERM'; } // exists but not accessible to us
}
function readClientProcesses() {
  // One CIM pass for everything: client process names/pids are readable
  // without elevation; the command line (the only live credential source on
  // current WeGame builds) requires the app to run elevated — same constraint
  // as LeagueAkari's UX command line reader.
  const script = "$p=Get-CimInstance Win32_Process -ErrorAction SilentlyContinue; @{c=@($p | Where-Object {$_.Name -in 'LeagueClientUx.exe','LeagueClient.exe','League of Legends.exe'} | Select-Object Name,ProcessId,CommandLine); r=@($p | Where-Object {$_.Name -eq 'RiotClientServices.exe'} | Select-Object -ExpandProperty ProcessId)} | ConvertTo-Json -Compress -Depth 4";
  return new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 4000, maxBuffer: 1024 * 128 }, (error, stdout) => {
    if (error || !stdout.trim()) {
      discoveryState.lastError = error ? String(error.message || error).slice(0, 120) : 'empty powershell output';
      return resolve(null);
    }
    let payload;
    try { payload = JSON.parse(stdout); } catch (e) { discoveryState.lastError = `parse: ${e.message}`; return resolve(null); }
    const entries = (Array.isArray(payload.c) ? payload.c : payload.c ? [payload.c] : [])
      .filter(Boolean)
      .map(item => ({
        name: String(item.Name || ''),
        pid: Number(item.ProcessId) || 0,
        cmdline: typeof item.CommandLine === 'string' ? item.CommandLine : ''
      }));
    const riotPids = Array.isArray(payload.r) ? payload.r : payload.r != null ? [payload.r] : [];
    // Prefer the UX process; fall back to the main client process.
    let lock = null;
    for (const wanted of ['LeagueClientUx.exe', 'LeagueClient.exe', 'League of Legends.exe']) {
      for (const entry of entries) {
        if (entry.name !== wanted || !entry.cmdline) continue;
        const port = entry.cmdline.match(/--app-port=(\d+)/i)?.[1];
        const password = entry.cmdline.match(/--remoting-auth-token=([^\s"]+)/i)?.[1];
        const protocol = entry.cmdline.match(/--app-protocol=(https?)/i)?.[1] || 'https';
        if (port && password) { lock = { port, password, protocol, file: 'client-process' }; break; }
      }
      if (lock) break;
    }
    discoveryState.lastError = '';
    resolve({
      processes: entries.map(({ cmdline, ...rest }) => rest),
      riotPids,
      lock
    });
  }));
}
function lcuGet(lock, endpoint) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port: Number(lock.port), path: endpoint, method: 'GET', rejectUnauthorized: false,
      headers: { Authorization: `Basic ${Buffer.from(`riot:${lock.password}`).toString('base64')}` } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => body += chunk);
      res.on('end', () => res.statusCode >= 200 && res.statusCode < 300 ? resolve(JSON.parse(body)) : reject(new Error(`LCU ${res.statusCode}`)));
    });
    req.setTimeout(1200, () => req.destroy(new Error('LCU timed out')));
    req.on('error', reject); req.end();
  });
}
function liveClientGet(endpoint) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port: 2999, path: endpoint, method: 'GET', rejectUnauthorized: false }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`Live Client ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch { resolve(body.replace(/^"|"$/g, '')); }
      });
    });
    req.setTimeout(1800, () => req.destroy(new Error('Live Client timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function detectInGameChampion() {
  try {
    const [activePlayerName, players] = await Promise.all([
      liveClientGet('/liveclientdata/activeplayername'),
      liveClientGet('/liveclientdata/playerlist')
    ]);
    const player = (players || []).find(item =>
      item.summonerName === activePlayerName || item.riotIdGameName === activePlayerName
    );
    if (!player) return null;
    const skinId = Number(player.skinID || 0);
    const championId = skinId >= 1000 ? Math.floor(skinId / 1000) : 0;
    const champions = await getChampionList();
    const champion = champions.find(item => item.id === championId);
    const name = champion?.name || player.championName;
    return name ? { id: championId, name, locked: true, inGame: true } : null;
  } catch {
    return null;
  }
}
function httpsJsonGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'champion-soundboard/0.1' } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => res.statusCode >= 200 && res.statusCode < 300 ? resolve(JSON.parse(body)) : reject(new Error(`HTTP ${res.statusCode}`)));
    });
    req.setTimeout(5000, () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
  });
}
async function getLcuConnections() {
  // Reading an elevated League process's command line from a non-elevated
  // launch fails, so this refresh runs on a 5s cadence instead of every poll.
  // It must also run even when a lockfile parses: a stale lockfile — or one
  // written by RiotClientServices, which serves no /lol-* endpoints — must not
  // mask the live client.
  if (Date.now() - lastProcessLockCheckAt > 5000) {
    lastProcessLockCheckAt = Date.now();
    const result = await readClientProcesses();
    if (result) {
      discoveryState.clientProcesses = result.processes;
      discoveryState.riotPids = result.riotPids;
      discoveryState.processLock = result.lock;
    } else {
      discoveryState.processLock = null;
    }
    recordDiscoveryStatus();
  }
  const riotPids = discoveryState.riotPids;
  const lockfileLocks = readLockfiles()
    .filter(lock => pidAlive(lock.pid))
    .filter(lock => !riotPids.includes(lock.pid));
  discoveryState.lockfileLocks = lockfileLocks.length;
  const locks = [];
  // The live client's own launch arguments are the most trustworthy source.
  if (discoveryState.processLock) locks.push(discoveryState.processLock);
  for (const lock of lockfileLocks) {
    if (!locks.some(item => item.port === lock.port)) locks.push(lock);
  }
  return locks;
}
function clientProcessState() {
  if (!discoveryState.clientProcesses.length) return 'no-client';
  return discoveryState.processLock ? 'client-ok' : 'client-no-cmdline';
}
function saveChampionCache(result) {
  const snapshot = JSON.stringify(result);
  if (snapshot === championCacheSnapshot) return;
  championCacheSnapshot = snapshot;
  try { fs.writeFileSync(path.join(app.getPath('userData'), 'champions-cache.json'), JSON.stringify(result, null, 2)); } catch { /* cache only */ }
}
function recordChampionListStatus(ok, count, endpoint) {
  const snapshot = `${ok ? '1' : '0'}|${count}|${endpoint}`;
  if (snapshot === championStatusSnapshot) return;
  championStatusSnapshot = snapshot;
  try { fs.writeFileSync(path.join(app.getPath('userData'), 'champion-list-status.json'), JSON.stringify({ ok, count, endpoint, checkedAt: new Date().toISOString() }, null, 2)); } catch { /* diagnostics only */ }
}

// Champion given names (e.g. 亚索 for 疾风剑豪) come from Riot's official
// Data Dragon zh_CN data, so brand-new champions are searchable without
// touching the manual nickname table. In zh_CN data `name` is the display
// title (matches LCU `name`) and `title` is the given name.
const DD_NAMES_TTL_MS = 60 * 60 * 1000;
let ddNamesCache = null; // { at, map }
let ddNamesInFlight = null;
function ddragonNamesPath() { return path.join(app.getPath('userData'), 'champion-dd-names.json'); }
async function getDdragonNicknames(force = false) {
  if (!force && ddNamesCache && Date.now() - ddNamesCache.at < DD_NAMES_TTL_MS) return ddNamesCache.map;
  if (ddNamesInFlight) return ddNamesInFlight;
  ddNamesInFlight = (async () => {
    try {
      const versions = await httpsJsonGet('https://ddragon.leagueoflegends.com/api/versions.json');
      const data = await httpsJsonGet(`https://ddragon.leagueoflegends.com/cdn/${versions[0]}/data/zh_CN/champion.json`);
      const map = {};
      for (const entry of Object.values(data.data || {})) {
        if (entry.name && entry.title) map[entry.name] = entry.title;
      }
      ddNamesCache = { at: Date.now(), map };
      try { fs.writeFileSync(ddragonNamesPath(), JSON.stringify({ checkedAt: new Date().toISOString(), map }, null, 2)); } catch { /* cache only */ }
      return map;
    } catch {
      // Offline: keep serving the last good copy so search keeps working.
      if (!ddNamesCache) {
        try {
          const cached = JSON.parse(fs.readFileSync(ddragonNamesPath(), 'utf8'));
          if (cached && cached.map) ddNamesCache = { at: Date.now(), map: cached.map };
        } catch { /* no cache yet */ }
      }
      return ddNamesCache?.map || {};
    } finally {
      ddNamesInFlight = null;
    }
  })();
  return ddNamesInFlight;
}
async function getChampionList(force = false) {
  if (!force && championListCache && Date.now() - championListCache.at < championListCache.ttl) return championListCache.result;
  const cachePath = path.join(app.getPath('userData'), 'champions-cache.json');
  const locks = await getLcuConnections();
  for (const lock of locks) {
    for (const endpoint of ['/lol-champions/v1/owned-champions-minimal', '/lol-game-data/v1/champions.json', '/lol-game-data/assets/v1/champion-summary.json']) {
      try {
        const champions = await lcuGet(lock, endpoint);
        if (!Array.isArray(champions)) continue;
        const unique = new Map();
        for (const champion of champions) {
          // Tencent builds may expose multiple numeric records for one display
          // champion. Mappings are keyed by localized name, so de-duplicate by
          // the same stable display value used by champion detection.
          if (champion.id > 0 && champion.id < 1000 && champion.name && !unique.has(champion.name)) unique.set(champion.name, champion);
        }
        const result = [...unique.values()]
          .map(champion => ({ id: champion.id, name: champion.name, alias: champion.alias || '' }))
          .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
        championListCache = { at: Date.now(), ttl: CHAMPION_LIST_TTL_MS, result };
        saveChampionCache(result);
        recordChampionListStatus(true, result.length, endpoint);
        return result;
      } catch { /* try another local client endpoint */ }
    }
  }
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (Array.isArray(cached) && cached.length) {
      // Serve the file only briefly between LCU retries so a poll with no
      // client does not reread it every second.
      championListCache = { at: Date.now(), ttl: CHAMPION_CACHE_FALLBACK_TTL_MS, result: cached };
      recordChampionListStatus(true, cached.length, 'local-cache');
      return cached;
    }
  } catch { /* cache will be created by the online fallback */ }
  try {
    const versions = await httpsJsonGet('https://ddragon.leagueoflegends.com/api/versions.json');
    const version = versions[0];
    const data = await httpsJsonGet(`https://ddragon.leagueoflegends.com/cdn/${version}/data/zh_CN/champion.json`);
    const result = Object.values(data.data || {})
      .map(champion => ({ id: Number(champion.key), name: champion.name, alias: champion.id || '' }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    if (result.length) {
      championListCache = { at: Date.now(), ttl: CHAMPION_LIST_TTL_MS, result };
      saveChampionCache(result);
      recordChampionListStatus(true, result.length, `Data Dragon ${version}`);
      return result;
    }
  } catch { /* report the unavailable list below */ }
  recordChampionListStatus(false, 0, '');
  return [];
}
async function pollChampion() {
  const locks = await getLcuConnections();
  if (!locks.length) {
    const inGameChampion = await detectInGameChampion();
    if (inGameChampion) {
      lastChampion = inGameChampion;
      emitChampion(lastChampion);
      emitLcuStatus({ connected: true, text: `游戏中：${lastChampion.name}` });
    } else if (clientProcessState() === 'client-no-cmdline') {
      // LeagueAkari behaves the same way: client processes are visible by name
      // without elevation, but their command line (the credentials) is not.
      emitLcuStatus({
        connected: false,
        text: appElevated === false
          ? '检测到客户端进程，但当前没有管理员权限读取连接信息；请从桌面快捷方式启动'
          : '已检测到客户端进程，但读取连接信息失败，稍后重试'
      });
    } else {
      lastChampion = null;
      emitChampion(null);
      emitLcuStatus({ connected: false, text: '未检测到运行中的英雄联盟客户端' });
    }
    return;
  }
  for (const lock of locks) {
    try {
      const session = await lcuGet(lock, '/lol-champ-select/v1/session');
      const me = (session.myTeam || []).find(p => p.cellId === session.localPlayerCellId) || (session.myTeam || [])[0];
      // Pre-pick is reported as championPickIntent. A lock is recorded on the
      // matching "pick" action, not reliably on the myTeam member itself.
      const championId = me?.championId || me?.championPickIntent;
      if (!me || !championId) { lastChampion = null; emitChampion(null); emitLcuStatus({ connected: true, text: '客户端已连接，等待选择英雄' }); return; }
      // Id→name lookup comes from the in-memory cache; a poll tick must not
      // refetch the full champion list from the LCU every second.
      const champions = await getChampionList();
      let champion = champions.find(c => c.id === championId);
      if (!champion && championId > 0 && championId < 1000 && Date.now() - lastUnknownChampionRefreshAt > 60000) {
        // An id we cannot name yet is often a brand-new champion right after a
        // patch; force one list refresh so its title shows up on its own.
        lastUnknownChampionRefreshAt = Date.now();
        const fresh = await getChampionList(true);
        champion = fresh.find(c => c.id === championId);
      }
      const name = champion?.name || String(championId);
      const picks = (session.actions || []).flat().filter(action =>
        (action.actorCellId ?? action.cellId) === me.cellId && action.type === 'pick'
      );
      const locked = picks.some(action => action.completed && action.championId === championId);
      lastChampion = { id: championId, name, locked };
      emitChampion(lastChampion);
      emitLcuStatus({ connected: true, text: `${locked ? '已锁定' : '预选中'}：${name}` });
      return;
    } catch { /* try the next local client endpoint */ }
  }
  const inGameChampion = await detectInGameChampion();
  if (inGameChampion) {
    lastChampion = inGameChampion;
    emitChampion(lastChampion);
    emitLcuStatus({ connected: true, text: `游戏中：${lastChampion.name}` });
    return;
  }
  // Only a known non-game phase clears the previous hero; transient endpoint
  // failures during loading must not switch the user's track source.
  if (lastChampion) try {
    const phase = await lcuGet(locks[0], '/lol-gameflow/v1/gameflow-phase');
    if (!['ChampSelect', 'InProgress', 'GameStart', 'Reconnect'].includes(phase)) { lastChampion = null; emitChampion(null); }
  } catch { /* retain the last selection while disconnected */ }
  emitLcuStatus({ connected: false, text: '已检测到客户端，等待英雄选择界面' });
}

async function pollChampionSafely() {
  if (lcuPollInFlight) return;
  lcuPollInFlight = true;
  try { await pollChampion(); }
  finally { lcuPollInFlight = false; }
}

function showMainWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
function createTray() {
  if (tray) return;
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'renderer', 'icon.png')));
    tray.setToolTip('英雄音乐台');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主窗口', click: showMainWindow },
      { type: 'separator' },
      { label: '退出', click: () => { showMainWindow(); closeConfirmInFlight = true; emit('confirm-close'); } }
    ]));
    tray.on('double-click', showMainWindow);
  } catch { /* tray is cosmetic; the app works without it */ }
}
function createWindow() {
  win = new BrowserWindow({ width: 840, height: 720, minWidth: 680, minHeight: 600, frame: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const ownPage = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;
  const permitted = (wc, permission) => wc === win?.webContents && wc.getURL() === ownPage && ['media', 'speaker-selection'].includes(permission);
  win.webContents.session.setPermissionRequestHandler((wc, permission, callback) => callback(permitted(wc, permission)));
  win.webContents.session.setPermissionCheckHandler((wc, permission) => permitted(wc, permission));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (url !== ownPage) event.preventDefault(); });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', async () => {
    try {
      const page = await win.webContents.executeJavaScript(`({url:location.href, title:document.title, libraryTitle:document.querySelector('#musicLibrary .fold-title')?.textContent, hasManualToggle:!!document.getElementById('manualToggle'), hasDailySlots:!!document.getElementById('dailySlots'), hasEndSlider:!!document.getElementById('segmentEndRange'), hasStyledConfirm:!!document.getElementById('confirmModal')})`);
      fs.writeFileSync(path.join(app.getPath('userData'), 'renderer-loaded-status.json'), JSON.stringify({ version: app.getVersion(), sourceRoot: __dirname, loadedAt: new Date().toISOString(), ...page }, null, 2));
    } catch { /* diagnostics must not affect the window */ }
  });
  for (const evt of ['maximize', 'unmaximize']) win.on(evt, () => emit('maximize-state', win.isMaximized()));
  win.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    if (config.closeAction === 'tray') { win.hide(); return; }
    if (closeConfirmInFlight) return;
    // Nobody can answer the in-app prompt before the renderer is ready (or
    // after it crashed); hiding to tray is the safe fallback.
    if (win.webContents.isLoading() || win.webContents.isCrashed()) { win.hide(); return; }
    closeConfirmInFlight = true;
    emit('confirm-close');
  });
}
app.on('second-instance', () => showMainWindow());
app.on('window-all-closed', () => { /* stay resident in the tray; exit via the tray menu */ });
app.on('before-quit', () => { quitting = true; });
app.whenReady().then(async () => {
  await loadConfig(); ensureTestTrack(); createWindow(); createTray(); startGameHotkeyHelper(config.playHotkeys, config.pauseHotkey); setShortcuts(config.playHotkeys, config.pauseHotkey);
  lcuTimer = setInterval(pollChampionSafely, 1000); pollChampionSafely();
  checkElevated();
  // The renderer may load after the first status was deduplicated away; make
  // sure it eventually receives the current state either way.
  setInterval(replayRendererState, 10000);
  if (!AUDIO_PREVIEW) ensureDesktopShortcut();
  getDdragonNicknames().catch(() => {}); // seed the automatic nickname table
  // Safety net: if the renderer dies mid-capture, restore global shortcuts.
  setInterval(() => {
    if (hotkeyCapture && Date.now() - hotkeyCapture.startedAt > 120000) {
      hotkeyCapture = null;
      setShortcuts(config.playHotkeys, config.pauseHotkey);
    }
  }, 1000);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('will-quit', () => { quitting = true; globalShortcut.unregisterAll(); if (hotkeyPollTimer) clearInterval(hotkeyPollTimer); if (hotkeyHelper && hotkeyHelper.exitCode === null) hotkeyHelper.kill(); });

ipcMain.handle('get-settings', () => ({ ...serializableConfig(), lastChampion }));
ipcMain.handle('report-playback', (_event, status) => {
  try { fs.writeFileSync(path.join(app.getPath('userData'), 'playback-status.json'), JSON.stringify({ ...status, reportedAt: new Date().toISOString() }, null, 2)); } catch { /* diagnostics only */ }
  return true;
});
ipcMain.handle('get-champions', () => getChampionList(true));
const avatarRequests = new Map();
function imageRequest(port, endpoint, password) {
  return new Promise((resolve, reject) => {
    const options = port ? { hostname: '127.0.0.1', port: Number(port), path: endpoint, rejectUnauthorized: false,
      headers: { Authorization: `Basic ${Buffer.from(`riot:${password}`).toString('base64')}` } } : endpoint;
    const req = https.get(options, res => {
      if (res.statusCode !== 200 || !String(res.headers['content-type']).startsWith('image/')) { res.resume(); return reject(new Error('Avatar unavailable')); }
      const parts = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) req.destroy(new Error('Avatar too large')); else parts.push(chunk); });
      res.on('error', reject);
      res.on('end', () => resolve(Buffer.concat(parts)));
    });
    req.setTimeout(3500, () => req.destroy(new Error('Avatar request timed out')));
    req.on('error', reject);
  });
}
ipcMain.handle('get-champion-avatar', async (_event, requestedId) => {
  const id = Number(requestedId);
  if (!Number.isInteger(id) || id <= 0 || id >= 1000) return null;
  if (avatarRequests.has(id)) return avatarRequests.get(id);
  const request = (async () => {
    const directory = path.join(app.getPath('userData'), 'champion-avatars');
    const target = path.join(directory, `${id}.png`);
    if (fs.existsSync(target)) return pathToFileURL(target).href;
    let data;
    for (const lock of await getLcuConnections()) {
      try { data = await imageRequest(lock.port, `/lol-game-data/assets/v1/champion-icons/${id}.png`, lock.password); break; } catch { /* offline fallback */ }
    }
    if (!data) {
      try {
        const versions = await httpsJsonGet('https://ddragon.leagueoflegends.com/api/versions.json');
        const champions = await getChampionList();
        const champion = champions.find(item => item.id === id);
        let alias = champion?.alias;
        if (!alias || !/^[A-Za-z0-9]+$/.test(alias)) {
          const names = await httpsJsonGet(`https://ddragon.leagueoflegends.com/cdn/${versions[0]}/data/zh_CN/champion.json`);
          alias = Object.values(names.data || {}).find(item => Number(item.key) === id)?.id;
        }
        if (!alias || !/^[A-Za-z0-9]+$/.test(alias)) return null;
        data = await imageRequest(null, `https://ddragon.leagueoflegends.com/cdn/${versions[0]}/img/champion/${alias}.png`);
      } catch { return null; }
    }
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(target, data);
    return pathToFileURL(target).href;
  })();
  avatarRequests.set(id, request);
  try { return await request; } finally { avatarRequests.delete(id); }
});
ipcMain.handle('get-champion-nicknames', (_event, force) => getDdragonNicknames(Boolean(force)));
ipcMain.handle('save-settings', async (_event, changes) => {
  if ('audioBackend' in changes && changes.audioBackend !== 'internal') return { ok: false, error: '未知的音频方案。' };
  const hotkeysChanged = Object.prototype.hasOwnProperty.call(changes, 'playHotkeys') || Object.prototype.hasOwnProperty.call(changes, 'pauseHotkey');
  if (hotkeysChanged) {
    const previous = { playHotkeys: [...config.playHotkeys], pauseHotkey: config.pauseHotkey };
    const merged = { ...config, ...changes };
    const validation = validateHotkeys(merged.playHotkeys, merged.pauseHotkey);
    if (!validation.ok) return { ok: false, error: validation.error };
    config = { ...merged, playHotkeys: validation.playHotkeys, pauseHotkey: validation.pauseHotkey };
    hotkeyCapture = null; // a confirmed save ends capture mode
    startGameHotkeyHelper(config.playHotkeys, config.pauseHotkey);
    const shortcut = setShortcuts(config.playHotkeys, config.pauseHotkey);
    if (!shortcut.ok) {
      // The new binding could not be registered (for example it is already in
      // use by another program); restore the previous bindings completely.
      config = { ...config, ...previous };
      startGameHotkeyHelper(config.playHotkeys, config.pauseHotkey);
      setShortcuts(config.playHotkeys, config.pauseHotkey);
      return { ok: false, error: shortcut.error || '新的快捷键注册失败，已恢复原设置。' };
    }
  } else {
    config = { ...config, ...changes };
  }
  await saveConfig(); return { ok: true, settings: serializableConfig() };
});
ipcMain.handle('begin-hotkey-capture', () => {
  hotkeyCapture = { startedAt: Date.now() };
  // Global shortcuts would swallow exactly the keys the renderer needs to read.
  globalShortcut.unregisterAll();
  return { ok: true };
});
ipcMain.handle('cancel-hotkey-capture', () => {
  hotkeyCapture = null;
  setShortcuts(config.playHotkeys, config.pauseHotkey);
  return { ok: true };
});
ipcMain.handle('renderer-ready', () => {
  replayRendererState();
  return true;
});
ipcMain.handle('window-control', (_event, action) => {
  if (!win || win.isDestroyed()) return false;
  if (action === 'minimize') win.minimize();
  else if (action === 'maximize') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
  else if (action === 'close') win.close();
  return true;
});
ipcMain.handle('close-choice', (_event, choice) => {
  closeConfirmInFlight = false;
  const action = choice?.action;
  if (action !== 'tray' && action !== 'exit') return true; // 取消：仅复位确认状态，窗口保持原样
  if (choice?.remember) {
    config.closeAction = action;
    saveConfig().catch(() => { /* 保存失败不影响本次选择 */ });
  }
  if (!win || win.isDestroyed()) return true;
  if (action === 'tray') win.hide();
  else { quitting = true; app.quit(); }
  return true;
});
// —— 首次配置向导 ——
ipcMain.handle('wizard-complete', async (_event, payload) => {
  const backend = payload?.audioBackend || 'internal';
  if (backend !== 'internal') return { ok: false, error: '未知的音频方案。' };
  const headphoneDeviceName = MusicModel.deviceName(payload?.headphoneDeviceName);
  const microphoneDeviceName = MusicModel.deviceName(payload?.microphoneDeviceName);
  if (!headphoneDeviceName || !microphoneDeviceName) return { ok: false, error: '请先选择耳机和麦克风。' };
  {
    const validId = id => typeof id === 'string' && id && !['default', 'communications'].includes(id);
    if (!validId(payload.internalMicDeviceId) || !validId(payload.cableOutputDeviceId) || !validId(payload.monitorDeviceId) || !/^CABLE(?:-[A-D])? Input\b/i.test(payload.cableOutputDeviceName || '') || /voicemeeter|cable|loopback|stereo mix|立体声混音/i.test(microphoneDeviceName + ' ' + headphoneDeviceName)) return { ok: false, error: '请明确选择真实耳机、麦克风和 CABLE Input。' };
    const backup = path.join(app.getPath('userData'), 'settings.before-internal-audio.json');
    if (!fs.existsSync(backup) && fs.existsSync(configPath())) await fsp.copyFile(configPath(), backup);
    config = { ...config, audioBackend: backend, internalMicDeviceId: payload.internalMicDeviceId, internalMicDeviceName: microphoneDeviceName, cableOutputDeviceId: payload.cableOutputDeviceId, cableOutputDeviceName: payload.cableOutputDeviceName, monitorDeviceId: payload.monitorDeviceId, headphoneDeviceName, setupDone: false };
    await saveConfig();
    return { ok: true, settings: serializableConfig(), defaultsUnchanged: true };
  }

});
ipcMain.handle('apply-mic-gain', async (_event, requestedGainDb) => {
  {
    config.internalMicGainDb = Math.round(Math.max(-24, Math.min(12, Number(requestedGainDb) || 0)) * 10) / 10;
    await saveConfig();
    return { ok: true, micGainDb: config.internalMicGainDb, backend: 'internal' };
  }

});
ipcMain.handle('cable-help', () => shell.openExternal('https://vb-audio.com/Cable/'));
ipcMain.handle('open-windows-sound', () => shell.openExternal('ms-settings:sound'));
ipcMain.handle('choose-audio', async () => {
  const result = await dialog.showOpenDialog(win, { title: '选择英雄音乐', properties: ['openFile'], filters: [{ name: '音频文件', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac'] }] });
  if (result.canceled || !result.filePaths[0]) return null;
  const filePath = result.filePaths[0]; return { path: filePath, url: pathToFileURL(filePath).href, name: path.basename(filePath) };
});
ipcMain.handle('read-mapped-audio', async (_event, filePath) => {
  const requested = path.resolve(String(filePath || ''));
  const mappedPaths = Object.values(config.mappings || {})
    .flatMap(value => Array.isArray(value) ? value : [value])
    .concat(MusicModel.slots(config.publicTracks))
    .filter(Boolean)
    .map(track => path.resolve(String(track.path || '')));
  if (!mappedPaths.includes(requested)) throw new Error('Audio file is not part of a saved champion mapping.');
  const stat = await fsp.stat(requested);
  if (!stat.isFile() || stat.size > 100 * 1024 * 1024) throw new Error('Audio file is unavailable or too large.');
  return fsp.readFile(requested);
});
ipcMain.handle('choose-lockfile', async () => {
  const result = await dialog.showOpenDialog(win, { title: '选择英雄联盟 lockfile', properties: ['openFile'], filters: [{ name: 'LCU lockfile', extensions: ['*'] }] });
  if (result.canceled || !result.filePaths[0]) return null;
  config.lockfilePath = result.filePaths[0]; await saveConfig(); pollChampionSafely(); return config.lockfilePath;
});
