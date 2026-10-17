const $ = id => document.getElementById(id);
const player = $('player');
const monitorPlayer = $('monitorPlayer');
const previewPlayer = $('previewPlayer');

// Mirrors HOTKEY_PATTERN in main.js: Ctrl/Shift (+ optional second modifier)
// plus a letter, digit or F1~F24.
const HOTKEY_PATTERN = /^(?:(?:Ctrl\+Shift|Shift\+Ctrl|Ctrl|Shift)\+)(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4]))$/;
const DEFAULT_PLAY_HOTKEYS = ['Ctrl+1', 'Ctrl+2', 'Ctrl+3'];

let settings;
let currentChampion = null;
let selectedTracks = [null, null, null];
let allChampionNames = [];
let activeKey = '';
let activeSlot = -1;
let activeTrack = null;
let qqAudioGraph = null;
let internalRoute = null;
let internalConnecting = false;
let internalConnectionTicket = 0;
let internalPendingDevices = null;
let audioDevices = [];
const weakEnabled = () => Boolean(settings?.internalWeakNetworkMode);
const stabilizerEnabled = () => Boolean(settings?.internalLoudnessStabilizer);
let captureTarget = null; // 0 | 1 | 2 | 'pause'
let capturedHotkey = '';
let captureStarting = false;
let editorMode = 'public';
let editorDirty = false;
let editorSelection = '';
let lastRecordedChampion = '';
let activeRange = { start: 0, end: Infinity };
let activeFinished = false;
let previewRange = { start: 0, end: Infinity };
let previewFinished = false;
let previewTrackSnapshot = null;
let playbackBusy = false;
let previewGeneration = 0;
let segmentSlot = -1;
let segmentDuration = 0;
let segmentDraftDirty = false;
let confirmationResolver = null;
let confirmationFocus = null;

function confirmAction(message, title = '修改尚未保存', action = '放弃修改', detail = '切换后，当前未保存的音乐配置将被放弃。') {
  if (confirmationResolver) return Promise.resolve(false);
  confirmationFocus = document.activeElement;
  $('confirmTitle').textContent = title;
  $('confirmMessage').textContent = message;
  $('confirmDetail').textContent = detail;
  $('confirmProceed').textContent = action;
  $('confirmCancel').textContent = title === '修改尚未保存' ? '继续编辑' : '取消';
  $('confirmModal').hidden = false;
  $('confirmCancel').focus();
  return new Promise(resolve => { confirmationResolver = resolve; });
}
function answerConfirmation(confirmed) {
  const resolve = confirmationResolver;
  confirmationResolver = null;
  $('confirmModal').hidden = true;
  confirmationFocus?.focus();
  if (resolve) resolve(confirmed);
}
const segmentProbe = document.createElement('audio');
segmentProbe.preload = 'metadata';
let segmentGeneration = 0;
let allChampions = [];
let avatarName = '';
let avatarGeneration = 0;
let playbackSnapshot = '';
async function updateAvatar(name) {
  if (avatarName === name) return;
  avatarName = name;
  const generation = ++avatarGeneration;
  $('championAvatar').hidden = true;
  $('avatarPlaceholder').hidden = false;
  const champion = allChampions.find(item => item.name === name);
  if (!champion) return;
  try {
    const url = await window.soundboard.getChampionAvatar(champion.id);
    if (generation !== avatarGeneration || !url) return;
    const image = $('championAvatar');
    image.onload = () => { if (generation === avatarGeneration) { image.hidden = false; $('avatarPlaceholder').hidden = true; } };
    image.onerror = () => { image.hidden = true; $('avatarPlaceholder').hidden = false; };
    image.src = url;
  } catch { /* placeholder remains available offline */ }
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '整首';
  const rounded = Math.round(Math.max(0, seconds) * 10) / 10;
  const whole = Math.floor(rounded);
  const fraction = Math.round((rounded - whole) * 10);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}${fraction ? `.${fraction}` : ''}`;
}
function parseTime(value) {
  const text = String(value).trim();
  if (!text) return null;
  if (!/^\d+(?::[0-5]\d)?(?:\.\d+)?$/.test(text)) throw new Error('请输入秒数或 分:秒，例如 75 或 1:15。');
  return text.includes(':') ? text.split(':').reduce((minutes, seconds) => Number(minutes) * 60 + Number(seconds)) : Number(text);
}
async function mediaReady(audio, url) {
  if (audio.src !== new URL(url, window.location.href).href) audio.src = url;
  if (audio.readyState >= 1) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error('音频加载超时，请检查文件是否存在。')), 8000);
    const loaded = () => done();
    const failed = () => done(new Error('音频无法读取，请检查文件路径和格式。'));
    function done(error) { clearTimeout(timer); audio.removeEventListener('loadedmetadata', loaded); audio.removeEventListener('error', failed); error ? reject(error) : resolve(); }
    audio.addEventListener('loadedmetadata', loaded, { once: true });
    audio.addEventListener('error', failed, { once: true });
  });
}
function renderPlaybackStatus() {
  const snapshot = `${activeTrack?.name}|${activeKey}|${activeSlot}|${activeFinished}|${player.paused}|${formatTime(player.currentTime)}|${activeRange.end}`;
  if (snapshot === playbackSnapshot) return;
  playbackSnapshot = snapshot;
  $('playingTitle').textContent = activeTrack?.name || '准备好你的第一段 BGM';
  $('playingSource').textContent = activeTrack ? `${activeKey} · ${slotAccelerator(activeSlot)}` : '在公共音乐池导入音乐，保存后即可播放';
  $('playingState').textContent = !activeTrack ? '待播放' : activeFinished ? '已结束' : player.paused ? '已暂停' : '播放中';
  const elapsed = activeTrack ? Math.max(0, player.currentTime - activeRange.start) : 0;
  const length = activeRange.end - activeRange.start;
  $('playingTime').textContent = `${formatTime(elapsed)} / ${Number.isFinite(length) ? formatTime(length) : '--:--'}`;
  $('playingProgress').value = activeTrack && Number.isFinite(length) ? Math.min(100, elapsed / length * 100) : 0;
  updateDailyPlayingState();
}
function updateDailyPlayingState() {
  for (let slot = 0; slot < 3; slot++) {
    const button = $(`dailySlot${slot}`);
    if (!button || !settings) continue;
    const resolved = MusicModel.resolve(settings, playbackChampionKey(), slot);
    const playing = resolved.key === activeKey && activeSlot === slot && MusicModel.same(resolved.track, activeTrack) && !player.paused;
    button.classList.toggle('is-playing', playing);
    button.setAttribute('aria-pressed', String(playing));
    const state = button.querySelector('.daily-action');
    if (state) state.textContent = !resolved.track ? '配置 →' : playing ? '暂停 Ⅱ' : '播放 ▷';
  }
}
function renderDailySlots() {
  const container = $('dailySlots');
  container.replaceChildren();
  for (let slot = 0; slot < 3; slot++) {
    const resolved = MusicModel.resolve(settings, playbackChampionKey(), slot);
    const button = document.createElement('button');
    button.id = `dailySlot${slot}`;
    button.className = 'daily-slot';
    const key = document.createElement('span'); key.className = 'daily-key'; key.textContent = slotAccelerator(slot);
    const name = document.createElement('strong'); name.textContent = resolved.track?.name || '添加一段 BGM';
    const source = document.createElement('small'); source.textContent = resolved.track ? (resolved.source === 'champion' ? '英雄专属' : '公共音乐池') : '尚未配置';
    const action = document.createElement('span'); action.className = 'daily-action';
    button.append(key, name, source, action);
    button.onclick = () => resolved.track ? playSlot(playbackChampionKey(), slot) : setEditorMode('public');
    container.append(button);
  }
  updateDailyPlayingState();
}
function finishActive() {
  player.pause(); monitorPlayer.pause();
  activeFinished = true;
  renderPlaybackStatus();
}
function checkSegmentEnd() {
  if (!player.paused && player.currentTime >= activeRange.end) finishActive();
  if (!previewPlayer.paused && previewPlayer.currentTime >= previewRange.end) {
    previewPlayer.pause(); previewFinished = true;
    $('segmentPreview').textContent = '重新试听片段';
  }
  if (!$('segmentEditor').hidden && previewPlayer.readyState >= 1 && !previewPlayer.paused) {
    $('segmentSeek').value = String(previewPlayer.currentTime);
    $('segmentPosition').textContent = `${formatTime(Math.max(0, previewPlayer.currentTime - previewRange.start))} / ${formatTime(previewRange.end - previewRange.start)}`;
  }
  renderPlaybackStatus();
}
player.addEventListener('timeupdate', checkSegmentEnd);
previewPlayer.addEventListener('timeupdate', checkSegmentEnd);
previewPlayer.addEventListener('ended', () => { previewFinished = true; $('segmentPreview').textContent = '重新试听片段'; });
setInterval(checkSegmentEnd, 50);

async function openSegment(slot) {
  if (segmentDraftDirty && slot === segmentSlot) { $('segmentEditor').hidden = false; return; }
  if (segmentDraftDirty && !await confirmAction('要编辑另一段音乐的片段吗？')) return;
  const track = selectedTracks[slot];
  if (!track) return show('先导入一段音频，再选择片段。', true);
  const generation = ++segmentGeneration;
  try {
    await mediaReady(segmentProbe, track.url);
    if (generation !== segmentGeneration) return;
    segmentSlot = slot;
    segmentDuration = segmentProbe.duration;
    const range = MusicModel.range(track, segmentDuration);
    $('segmentTitle').textContent = track.name;
    $('segmentStart').value = String(range.start);
    $('segmentEnd').value = Number.isFinite(track.endTime) ? String(range.end) : '';
    for (const id of ['segmentStartRange', 'segmentEndRange']) { $(id).max = String(segmentDuration); $(id).step = '0.01'; }
    $('segmentStartRange').value = String(range.start);
    $('segmentEndRange').value = String(range.end);
    segmentDraftDirty = false;
    updateSegmentDisplay();
    $('segmentSeek').max = String(segmentDuration);
    $('segmentSeek').value = String(range.start);
    $('segmentPosition').textContent = `${formatTime(range.start)} / ${formatTime(segmentDuration)}`;
    $('segmentPreview').textContent = '试听完整片段';
    $('segmentEditor').hidden = false;
  } catch (error) { show(error.message, true); }
}
function updateSegmentDisplay() {
  ++previewGeneration;
  previewPlayer.pause();
  $('segmentPreview').textContent = '试听完整片段';
  try {
    const track = readSegment();
    const range = MusicModel.range(track, segmentDuration);
    $('segmentStartRange').value = String(range.start);
    $('segmentEndRange').value = String(range.end);
    $('segmentStartValue').textContent = formatTime(range.start);
    $('segmentEndValue').textContent = formatTime(range.end);
    $('segmentLength').textContent = `已选 ${formatTime(range.end - range.start)} · ${formatTime(range.start)} 至 ${formatTime(range.end)}`;
    $('segmentLength').classList.remove('error');
    $('segmentSeek').min = String(range.start);
    $('segmentSeek').max = String(range.end);
    if (!previewPlayer.paused) { previewPlayer.pause(); $('segmentPreview').textContent = '试听完整片段'; }
  } catch (error) { $('segmentLength').textContent = error.message; $('segmentLength').classList.add('error'); }
}
function dragSegmentBoundary(start) {
  const gap = Math.min(0.01, segmentDuration / 2);
  let first = Number($('segmentStartRange').value);
  let last = Number($('segmentEndRange').value);
  if (start) first = Math.min(first, last - gap);
  else last = Math.max(last, first + gap);
  $('segmentStart').value = String(Math.max(0, first));
  $('segmentEnd').value = String(Math.min(segmentDuration, last));
  segmentDraftDirty = true;
  updateSegmentDisplay();
}
function readSegment() {
  const startTime = parseTime($('segmentStart').value) ?? 0;
  const endTime = parseTime($('segmentEnd').value);
  const candidate = { ...selectedTracks[segmentSlot], startTime, endTime };
  if (endTime !== null && endTime > segmentDuration) throw new Error('结束时间不能超过音频总长度。');
  MusicModel.range(candidate, segmentDuration);
  return candidate;
}
function updateTrackRows() {
  selectedTracks.forEach((track, slot) => {
    $(`trackLabel${slot + 1}`).value = track?.name || '';
    $(`trackRange${slot + 1}`).textContent = track ? `${formatTime(track.startTime || 0)} → ${track.endTime == null ? '结尾' : formatTime(track.endTime)}` : editorMode === 'public' ? '尚未配置 · 导入一段常用 BGM' : '空槽 · 自动使用公共音乐';
  });
}

async function setEditorMode(mode, champion = '') {
  if (mode === editorMode && (!champion || champion === championKey())) { $('musicLibrary').open = true; return; }
  if ((editorDirty || segmentDraftDirty) && !await confirmAction('要切换音乐配置吗？')) return;
  editorDirty = false;
  segmentDraftDirty = false;
  editorMode = mode;
  if (champion) { ensureChampionOption(champion); $('championInput').value = champion; }
  $('heroEditor').hidden = mode === 'public';
  $('editPublic').setAttribute('aria-selected', String(mode === 'public'));
  $('editChampion').setAttribute('aria-selected', String(mode === 'champion'));
  editorDirty = false;
  applyMappingView();
  $('musicLibrary').open = true;
  $('musicLibrary').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderLibraryStatus() {
  const key = settings.manualChampion || currentChampion?.name || '';
  const ownCount = tracksFor(key).filter(Boolean).length;
  $('currentChampion').textContent = key || '公共音乐随时待命';
  $('championHint').textContent = settings.manualChampion ? '手动指定 · 当前按键使用此英雄' :
    !currentChampion ? '等待英雄选择 · 可先播放公共音乐' : currentChampion.inGame ? '游戏中' : currentChampion.locked ? '已锁定 · 音乐配置已就绪' : '预选中 · 锁定后继续跟随';
  $('quickConfigure').hidden = !key || ownCount === 3;
  $('quickConfigure').textContent = `配置 ${key}（${ownCount}/3）`;
  $('playbackMode').value = settings.playbackMode || 'auto';
  const resolved = [0, 1, 2].map(slot => MusicModel.resolve(settings, key, slot));
  const ownUsed = resolved.filter(item => item.track && item.source === 'champion').length;
  const publicUsed = resolved.filter(item => item.track && item.source === 'public').length;
  $('championLibraryHint').textContent = ownUsed ? `当前使用 ${ownUsed} 段专属${publicUsed ? ` + ${publicUsed} 段公共音乐` : '音乐'}` : publicUsed ? '当前使用公共音乐池' : '先添加一段公共音乐，即可开始播放';
  $('heroMode').textContent = settings.manualChampion ? '手动指定' : '自动检测';
  $('heroMode').classList.toggle('manual-mode', Boolean(settings.manualChampion));
  $('restoreAuto').hidden = !settings.manualChampion;
  const publicCount = MusicModel.slots(settings.publicTracks).filter(Boolean).length;
  const configuredCount = Object.values(settings.mappings || {}).filter(value => MusicModel.slots(value).some(Boolean)).length;
  $('librarySummary').textContent = `公共池 ${publicCount} 段 · 已配置 ${configuredCount} 位英雄${editorDirty ? ' · 有未保存修改' : ''}`;
  renderDailySlots();
  updateAvatar(key);
  const recent = $('recentChampions');
  recent.replaceChildren();
  for (const name of settings.recentChampions || []) {
    const button = document.createElement('button');
    button.textContent = name;
    button.onclick = () => setEditorMode('champion', name);
    recent.append(button);
  }
  $('recentSection').hidden = !recent.childElementCount;
}

async function recordRecent(name) {
  if (!name || lastRecordedChampion === name) return;
  lastRecordedChampion = name;
  const result = await window.soundboard.saveSettings({ recentChampions: MusicModel.recent(settings.recentChampions || [], name) });
  if (result.ok) { settings = result.settings; renderLibraryStatus(); }
}

function slotAccelerator(slot) { return settings?.playHotkeys?.[slot] || DEFAULT_PLAY_HOTKEYS[slot]; }
function pauseAcceleratorText() { return settings?.pauseHotkey || 'Ctrl+A'; }

function hotkeyDisplays() {
  for (let slot = 0; slot < 3; slot++) {
    $(`slotKey${slot + 1}`).textContent = slotAccelerator(slot);
    $(`hotkey${slot}`).value = slotAccelerator(slot);
  }
  $('hotkeyPause').value = pauseAcceleratorText();
  $('playbackHelp').textContent = `播放中再按相同播放键（当前 ${slotAccelerator(0)} / ${slotAccelerator(1)} / ${slotAccelerator(2)}）或 ${pauseAcceleratorText()}，都会暂停并从原进度继续。Ctrl+4 从当前片段起点重新播放。`;
  if (settings) renderDailySlots();
}

function captureLabel(target) { return target === 'pause' ? '暂停/继续' : `播放键 ${Number(target) + 1}`; }

async function startHotkeyCapture(target) {
  if (captureTarget !== null || captureStarting) return show('正在修改快捷键；请先确认或取消。', true);
  captureStarting = true;
  let result;
  try { result = await window.soundboard.beginHotkeyCapture(); }
  catch (error) { show(`无法修改快捷键：${error.message}`, true); }
  finally { captureStarting = false; }
  if (!result?.ok) return show('无法进入快捷键修改模式。', true);
  captureTarget = target;
  capturedHotkey = '';
  $('captureBar').hidden = false;
  $('captureConfirm').disabled = true;
  $('captureBar').focus();
  $('captureHint').textContent = `正在修改「${captureLabel(target)}」：请按下新的快捷键（Ctrl 或 Shift + 字母/数字/F1~F24），按 Esc 取消。`;
  show(`正在修改「${captureLabel(target)}」的快捷键；改键期间播放快捷键临时失效。`);
}

function acceleratorFromEvent(event) {
  if (event.key === 'Escape') return { cancel: true };
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return { ignore: true };
  const code = event.code || '';
  let key = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F(?:[1-9]|1\d|2[0-4])$/.test(code)) key = code;
  if (!key) return { error: '请使用主键盘区的字母、数字或 F1~F24（小键盘数字不支持）。' };
  if (event.altKey) return { error: '暂不支持 Alt 组合；请使用 Ctrl 或 Shift。' };
  if (!event.ctrlKey && !event.shiftKey) return { error: '请至少按住 Ctrl 或 Shift，避免与普通打字冲突。' };
  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.shiftKey) parts.push('Shift');
  return { accelerator: `${parts.join('+')}+${key}` };
}

window.addEventListener('keydown', event => {
  if (captureTarget === null) return;
  if (!['Control', 'Shift', 'Alt', 'Meta', 'Escape'].includes(event.key) && (!event.ctrlKey && !event.shiftKey) && ['Enter', 'Tab'].includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  const parsed = acceleratorFromEvent(event);
  if (parsed.ignore) return;
  if (parsed.cancel) { cancelHotkeyCapture(); return; }
  if (parsed.error) {
    $('captureHint').textContent = `${parsed.error} 正在修改「${captureLabel(captureTarget)}」…`;
    capturedHotkey = '';
    $('captureConfirm').disabled = true;
    return;
  }
  capturedHotkey = parsed.accelerator;
  $('captureConfirm').disabled = false;
  $('captureHint').textContent = `已读取「${captureLabel(captureTarget)}」的新快捷键：${capturedHotkey}。点击“确认保存”生效。`;
}, true);

function endHotkeyCaptureUi() {
  captureTarget = null;
  capturedHotkey = '';
  $('captureBar').hidden = true;
  hotkeyDisplays();
}

async function cancelHotkeyCapture() {
  if (captureTarget === null) return;
  try { await window.soundboard.cancelHotkeyCapture(); }
  finally { endHotkeyCaptureUi(); }
}

async function confirmHotkeyCapture() {
  if (captureTarget === null || !capturedHotkey) return;
  const target = captureTarget;
  const nextPlay = (settings.playHotkeys || [...DEFAULT_PLAY_HOTKEYS]).slice();
  let nextPause = settings.pauseHotkey || 'Ctrl+A';
  if (target === 'pause') nextPause = capturedHotkey;
  else nextPlay[Number(target)] = capturedHotkey;
  const combined = [...nextPlay, nextPause].map(value => String(value).toUpperCase());
  if (combined.includes('CTRL+4')) { $('captureHint').textContent = 'Ctrl+4 已保留用于从头播放当前 BGM，请换一个组合。'; return; }
  if ([...nextPlay, nextPause].some(value => !HOTKEY_PATTERN.test(value)) || new Set(combined).size !== combined.length) {
    $('captureHint').textContent = '该快捷键无效或与其他键位重复，请换一个组合。';
    capturedHotkey = '';
    $('captureConfirm').disabled = true;
    return;
  }
  const changes = target === 'pause' ? { pauseHotkey: capturedHotkey } : { playHotkeys: nextPlay };
  let result;
  try { result = await window.soundboard.saveSettings(changes); }
  catch (error) { show(`保存快捷键失败：${error.message}`, true); await cancelHotkeyCapture(); return; }
  if (result.ok) {
    settings = result.settings;
    endHotkeyCaptureUi();
    show(`「${captureLabel(target)}」快捷键已保存为 ${target === 'pause' ? settings.pauseHotkey : settings.playHotkeys[Number(target)]}。`);
  } else {
    show(result.error || '快捷键保存失败，已恢复原设置。', true);
    await window.soundboard.cancelHotkeyCapture();
    endHotkeyCaptureUi();
  }
}

function applyWeakNetworkGraph() {
  if (!qqAudioGraph) return;
  const weak = weakEnabled();
  // 响度稳定器只在弱网模式关闭时生效（弱网模式自身含更强的压缩处理）。
  const stab = !weak && stabilizerEnabled();
  const now = qqAudioGraph.context.currentTime;
  qqAudioGraph.bypassGain.gain.setValueAtTime(!weak && !stab ? 1 : 0, now);
  qqAudioGraph.weakGain.gain.setValueAtTime(weak ? 1 : 0, now);
  qqAudioGraph.stabGain.gain.setValueAtTime(stab ? 1 : 0, now);
  qqAudioGraph.outputGain.gain.setValueAtTime(settings?.musicVolume ?? 0.4, now);
}

async function ensureQqAudioGraph() {
  if (qqAudioGraph) {
    if (qqAudioGraph.context.state === 'suspended') await qqAudioGraph.context.resume();
    applyWeakNetworkGraph();
    return true;
  }
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return false;
  try {
    const context = new AudioContextClass({ latencyHint: 'interactive', sampleRate: 48000 });
    const source = context.createMediaElementSource(player);
    const highpass = context.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 120;
    highpass.Q.value = 0.7;
    const lowpass = context.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 7000;
    lowpass.Q.value = 0.7;
    const mono = context.createGain();
    mono.channelCount = 1;
    mono.channelCountMode = 'explicit';
    mono.channelInterpretation = 'speakers';
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -24;
    compressor.knee.value = 12;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.01;
    compressor.release.value = 0.25;
    // 响度稳定器通路：全频段立体声，只压缩动态并抬高安静段。
    const stabCompressor = context.createDynamicsCompressor();
    stabCompressor.threshold.value = -30;
    stabCompressor.knee.value = 12;
    stabCompressor.ratio.value = 3;
    stabCompressor.attack.value = 0.005;
    stabCompressor.release.value = 0.25;
    const stabMakeup = context.createGain();
    stabMakeup.gain.value = 2.5; // ≈ +8 dB 增益补偿，抵消压缩带来的整体变小
    const stabGain = context.createGain();
    stabGain.gain.value = 0;
    const bypassGain = context.createGain();
    const weakGain = context.createGain();
    const outputGain = context.createGain();

    source.connect(bypassGain).connect(outputGain);
    source.connect(stabCompressor);
    stabCompressor.connect(stabMakeup);
    stabMakeup.connect(stabGain);
    stabGain.connect(outputGain);
    source.connect(highpass).connect(lowpass).connect(mono).connect(compressor).connect(weakGain).connect(outputGain);
    qqAudioGraph = { context, source, highpass, lowpass, mono, compressor, stabCompressor, stabMakeup, stabGain, bypassGain, weakGain, outputGain };
    player.volume = 1;
    applyWeakNetworkGraph();
    await context.resume();
    return true;
  } catch (error) {
    window.soundboard.reportPlayback({ ok: false, action: 'weak-network-init-error', error: String(error) });
    return false;
  }
}

function show(text, error = false) {
  $('notice').textContent = text;
  $('notice').style.color = error ? '#b42335' : '#376652';
}

function updateVolumeDisplay(value = settings?.musicVolume ?? 0.4) {
  const percent = Math.round(Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0.13)) * 100);
  $('musicVolume').value = String(percent);
  $('musicVolumeValue').textContent = `${percent}%`;
  $('volumeSummary').textContent = `${percent}%`;
  const monitorPercent = Math.round((settings?.monitorVolume ?? value ?? 0.13) * 100);
  $('monitorVolume').value = String(monitorPercent);
  $('monitorVolumeValue').textContent = `${monitorPercent}%`;
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)))];
}

function championKey() { return $('championInput').value.trim(); }

// Hotkey playback priority: manual override > auto-detected > mapping editor.
function playbackChampionKey() { return settings.manualChampion || currentChampion?.name || ''; }

function applyManualView() {
  const manual = settings.manualChampion || '';
  const detected = currentChampion?.name || '';
  if (manual) $('manualHint').textContent = `快捷键将播放手动指定的「${manual}」的映射；自动检测到的英雄被覆盖。`;
  else if (detected) $('manualHint').textContent = `快捷键当前使用自动检测的「${detected}」。`;
  else $('manualHint').textContent = '快捷键当前跟随自动检测。';
}

function renderManualOptions(filter = '') {
  const select = $('manualChampion');
  const current = settings.manualChampion || '';
  const keyword = filter.trim().toLocaleLowerCase('zh-CN');
  const visible = keyword
    ? allChampionNames.filter(name => championMatches(name, keyword))
    : allChampionNames;
  select.replaceChildren(new Option('（自动检测）', ''));
  for (const name of visible) select.add(new Option(name, name));
  if (!keyword) {
    select.value = current;
    applyManualView();
    return;
  }
  // 搜索时只显示匹配项；唯一命中视为用户已做出选择，直接提交。
  if (visible.length === 1 && visible[0] !== current) {
    setManualChampion(visible[0]);
    return;
  }
  if (visible.includes(current)) select.value = current;
  applyManualView();
}

async function setManualChampion(value) {
  const result = await window.soundboard.saveSettings({ manualChampion: value || '' });
  if (result.ok) {
    settings = result.settings;
    $('manualChampion').value = settings.manualChampion || '';
    applyManualView();
    renderLibraryStatus();
    if (value) recordRecent(value);
    show(settings.manualChampion
      ? `已手动指定英雄「${settings.manualChampion}」，快捷键将播放它的映射。`
      : '已恢复自动检测英雄。');
  } else show(result.error, true);
}

function tracksFor(key) {
  const value = settings?.mappings?.[key];
  if (Array.isArray(value)) return [value[0] || null, value[1] || null, value[2] || null];
  // Keep the renderer compatible with a settings file from an older build.
  return value && typeof value === 'object' ? [value, null, null] : [null, null, null];
}

// 匹配称号或昵称：champion-aliases.js 的手工昵称表 + 启动时从 Data Dragon
// 自动抓取的官方本名（覆盖新英雄），都只用于检索，不进入选项列表。
let championNicknames = {};
function championMatches(name, keyword) {
  if (name.toLocaleLowerCase('zh-CN').includes(keyword)) return true;
  const manual = typeof CHAMPION_ALIASES === 'object' ? CHAMPION_ALIASES[name] : null;
  if (Array.isArray(manual) && manual.some(alias => alias.toLocaleLowerCase('zh-CN').includes(keyword))) return true;
  const auto = championNicknames[name];
  return typeof auto === 'string' && auto.toLocaleLowerCase('zh-CN').includes(keyword);
}

function renderChampionOptions(filter = '') {
  const select = $('championInput');
  const current = select.value;
  const keyword = filter.trim().toLocaleLowerCase('zh-CN');
  const visible = keyword
    ? allChampionNames.filter(name => championMatches(name, keyword))
    : allChampionNames;
  select.replaceChildren(new Option(keyword ? `匹配到 ${visible.length} 名英雄` : '请选择英雄', ''));
  for (const name of visible) select.add(new Option(name, name));
  if ((editorDirty || segmentDraftDirty) && current && !visible.includes(current)) select.add(new Option(current, current));
  if (visible.includes(current) || ((editorDirty || segmentDraftDirty) && current)) select.value = current;
  else if (visible.length === 1 && !editorDirty && !segmentDraftDirty) select.value = visible[0];
  applyMappingView();
}

function ensureChampionOption(name) {
  if (!name || allChampionNames.includes(name)) return;
  allChampionNames.push(name);
  allChampionNames.sort((a, b) => a.localeCompare(b, 'zh-CN'));
  renderChampionOptions($('championSearch').value);
  renderManualOptions($('manualChampionSearch').value);
}

function applyMappingView() {
  const key = championKey();
  const selection = editorMode === 'public' ? '__public__' : key;
  if ((editorDirty || segmentDraftDirty) && editorSelection === selection) return;
  editorSelection = selection;
  selectedTracks = editorMode === 'public' ? MusicModel.slots(settings.publicTracks) : tracksFor(key);
  selectedTracks.forEach((track, slot) => {
    $(`trackLabel${slot + 1}`).value = track?.name || '';
    $(`trackLabel${slot + 1}`).placeholder = `未设置第 ${slot + 1} 条音乐`;
  });
  updateTrackRows();
  $('segmentEditor').hidden = true;
  segmentSlot = -1;
  segmentDraftDirty = false;
  if (!key && editorMode !== 'public') {
    $('mappingInfo').textContent = '请选择英雄，或使用自动检测到的英雄。';
    return;
  }
  const summary = selectedTracks.map((track, slot) => `${slotAccelerator(slot)}：${track?.name || '未设置'}`).join('；');
  $('mappingInfo').textContent = `“${editorMode === 'public' ? '公共音乐池' : key}” — ${summary}`;
  $('removeMapping').textContent = editorMode === 'public' ? '清空公共池' : '移除该英雄全部映射';
}

async function setSink(audio, deviceId, errorMessage) {
  if (typeof audio.setSinkId !== 'function') { show('当前环境不支持选择音频输出设备。', true); return false; }
  try {
    await audio.setSinkId(deviceId || '');
    return true;
  } catch {
    show(errorMessage, true);
    return false;
  }
}

async function setOutputDevices() {
  {
    try {
      InternalAudio.validate(internalSelection());
      const monitorId = $('monitorDevice').value;
      const ok = await setSink(monitorPlayer, monitorId, '耳机监听设备不可用。');
      const previewOk = await setSink(previewPlayer, monitorId, '耳机试听设备不可用。');
      $('outputStatus').textContent = ok && previewOk ? 'CABLE 输出已选择 · 耳机已绑定 · 人声状态见混音面板' : '耳机连接失败，请检查设备。';
      return ok && previewOk;
    } catch (error) { $('outputStatus').textContent = error.message; return false; }
  }

}

function pauseActive(message) {
  player.pause();

  monitorPlayer.pause();
  try { monitorPlayer.currentTime = player.currentTime; } catch { /* media not ready */ }
  window.soundboard.reportPlayback({
    ok: true,
    action: 'paused',
    key: activeKey,
    slot: activeSlot,
    track: activeTrack?.name || '',
    currentTime: player.currentTime,
    sinkId: qqAudioGraph?.context.sinkId || settings.cableOutputDeviceId || '',
    monitorSinkId: monitorPlayer.sinkId || ''
  });
  show(message || `已暂停：${activeTrack?.name || '当前音乐'}。再次按键将从当前位置继续。`);
  renderPlaybackStatus();
}

async function startActive(resume = false) {
  if (!activeTrack?.url) return false;
  const output = await setOutputDevices();
  if (!output) return false;
  if (!await connectInternalAudio()) return false;
  stopOutputTest();
  ++previewGeneration;
  previewPlayer.pause();
  applyWeakNetworkGraph();
  player.volume = qqAudioGraph ? 1 : (settings.musicVolume ?? 0.4);
  monitorPlayer.volume = settings.monitorVolume ?? settings.musicVolume ?? 0.13;
  try { monitorPlayer.currentTime = player.currentTime; } catch { /* media will align after loading */ }

  const playRequests = [player.play(), monitorPlayer.play()];
  const [formalResult, monitorResult] = await Promise.allSettled(playRequests);
  if (formalResult.status === 'rejected') {
    player.pause();

    monitorPlayer.pause();
    const reason = formalResult.reason;
    window.soundboard.reportPlayback({ ok: false, action: 'play-error', key: activeKey, slot: activeSlot, track: activeTrack.name, error: String(reason), sinkId: qqAudioGraph?.context.sinkId || settings.cableOutputDeviceId || '' });
    show('音乐输出失败，请检查 CABLE 与麦克风连接状态。', true);
    return false;
  }

  const monitorOk = monitorResult.status === 'fulfilled';
  window.soundboard.reportPlayback({
    ok: true,
    action: resume ? 'resumed' : 'playing',
    key: activeKey,
    slot: activeSlot,
    track: activeTrack.name,
    currentTime: player.currentTime,
    volume: settings.musicVolume ?? 0.4,
    audioBackend: settings.audioBackend,
    internalAudio: internalRoute?.diagnostics(),
    weakNetworkMode: weakEnabled(),
    sinkId: qqAudioGraph?.context.sinkId || settings.cableOutputDeviceId || '',
    monitorSinkId: monitorPlayer.sinkId || '',
    monitorOk,
    src: player.src
  });
  const prefix = resume ? '已从暂停位置继续' : '正在播放';
  const weakText = weakEnabled() ? '，QQ 弱网模式' : '';
  show(`${prefix}：${activeTrack.name}（${activeKey} · ${slotAccelerator(activeSlot)}，语音音量 ${Math.round((settings.musicVolume ?? 0.13) * 100)}%${weakText}）${monitorOk ? '；语音设备与耳机同步输出。' : '；语音输出已启动，耳机监听失败。'}`, !monitorOk);
  renderPlaybackStatus();
  return true;
}

async function playSlot(key, slot) {
  if (playbackBusy) return;
  playbackBusy = true;
  try {
  const resolved = MusicModel.resolve(settings, key, slot);
  const track = resolved.track;
  key = resolved.key;
  if (!track?.url) return show(`${slotAccelerator(slot)} 尚未配置音乐；请先在公共池导入音乐。`, true);

  const resolvedUrl = new URL(track.url, window.location.href).href;
  const sameTrack = activeKey === key && activeSlot === slot && player.src === resolvedUrl && MusicModel.same(activeTrack, track);
  if (sameTrack && !player.paused) {
    pauseActive(`已暂停：${track.name}。再次按 ${slotAccelerator(slot)} 或 ${pauseAcceleratorText()} 将从当前位置继续。`);
    return;
  }
  if (!sameTrack || player.ended || activeFinished) {
    player.pause();

    monitorPlayer.pause();
    ++previewGeneration;
    previewPlayer.pause();
    await Promise.all([mediaReady(player, track.url), mediaReady(monitorPlayer, track.url)]);
    activeRange = MusicModel.range(track, player.duration);
    player.currentTime = activeRange.start;
    monitorPlayer.currentTime = activeRange.start;
    activeFinished = false;
    activeKey = key;
    activeSlot = slot;
    activeTrack = { ...track };
  }
  await startActive(sameTrack && !player.ended);
  } catch (error) {
    player.pause(); monitorPlayer.pause();
    show(error.message || '播放失败。', true);
  } finally { playbackBusy = false; }
}

async function togglePausePlayback() {
  if (playbackBusy) return;
  if (!activeTrack || !player.src) return show('当前没有正在播放或暂停的音乐。', true);
  if (!player.paused) {
    pauseActive(`已暂停：${activeTrack.name}。再次按 ${pauseAcceleratorText()} 或 ${slotAccelerator(activeSlot)} 将从当前位置继续。`);
    return;
  }
  playbackBusy = true;
  try {
    if (activeFinished || player.ended) { player.currentTime = activeRange.start; activeFinished = false; }
    await startActive(true);
  } catch (error) { show(error.message, true); }
  finally { playbackBusy = false; }
}
async function restartCurrentPlayback() {
  if (playbackBusy) return;
  if (!activeTrack || !player.src) return show('当前没有可重播的 BGM，请先选择播放一段音乐。', true);
  playbackBusy = true;
  try {
    player.pause(); monitorPlayer.pause();
    player.currentTime = activeRange.start;
    monitorPlayer.currentTime = activeRange.start;
    activeFinished = false;
    await startActive(false);
  } catch (error) {
    player.pause(); monitorPlayer.pause();
    show(error.message || '重新播放失败。', true);
  } finally { playbackBusy = false; }
}

async function previewTrack(slot, override = null, resumeOverride = false) {
  const generation = ++previewGeneration;
  const track = override || selectedTracks[slot];
  if (!track?.url) return show(`请先为 ${slotAccelerator(slot)} 导入音乐。`, true);
  const monitorId = $('monitorDevice').value || settings.monitorDeviceId || '';
  if (!audioDevices.some(device => device.kind === 'audiooutput' && device.deviceId === monitorId && !InternalAudio.isAlias(monitorId) && !InternalAudio.isVirtual(device.label))) return show('请先选择真实耳机，再试听音乐。', true);
  if (!await setSink(previewPlayer, monitorId, '无法连接耳机试听输出设备。')) return;
  const resolvedUrl = new URL(track.url, window.location.href).href;
  const samePreview = previewPlayer.src === resolvedUrl && MusicModel.same(previewTrackSnapshot, track);
  if (!override && samePreview && !previewPlayer.paused) {
    previewPlayer.pause();
    return show(`已暂停试听：${track.name}。`);
  }
  try {
    if (!player.paused) pauseActive('已暂停正式播放，开始耳机试听。');
    previewPlayer.pause();
    await mediaReady(previewPlayer, track.url);
    if (generation !== previewGeneration) return;
    previewRange = MusicModel.range(track, previewPlayer.duration);
    if ((override && !resumeOverride) || !samePreview || previewFinished || previewPlayer.ended) previewPlayer.currentTime = previewRange.start;
    previewFinished = false;
    previewTrackSnapshot = { ...track };
    previewPlayer.volume = settings.monitorVolume ?? settings.musicVolume ?? 0.13;
    await previewPlayer.play();
    show(`正在从耳机试听：${track.name}（音量 ${Math.round(previewPlayer.volume * 100)}%）`);
  } catch {
    show('无法试听该音频文件；请确认文件仍然存在且格式受支持。', true);
  }
}

async function refreshChampions() {
  const select = $('championInput');
  const previous = select.value || settings?.selectedChampion || '';
  select.disabled = true;
  try {
    const champions = await window.soundboard.getChampions();
    allChampions = champions;
    avatarName = '';
    renderLibraryStatus();
    // 新英雄的本名从官方数据自动刷新（force，保证刚发布的英雄也能搜到）
    window.soundboard.getChampionNicknames(true).then(map => {
      if (map && Object.keys(map).length) {
        championNicknames = map;
        renderChampionOptions($('championSearch').value);
        renderManualOptions($('manualChampionSearch').value);
      }
    }).catch(() => { /* 搜索退化为仅称号+手工昵称表 */ });
    const names = champions.map(champion => champion.name);
    for (const mapped of Object.keys(settings?.mappings || {})) if (!names.includes(mapped)) names.push(mapped);
    names.sort((a, b) => a.localeCompare(b, 'zh-CN'));
    allChampionNames = names;
    renderChampionOptions($('championSearch').value);
    renderManualOptions($('manualChampionSearch').value);
    const mappedChampions = Object.keys(settings?.mappings || {});
    const fallback = previous || (mappedChampions.length === 1 ? mappedChampions[0] : '');
    if (fallback && names.includes(fallback)) select.value = fallback;
    applyMappingView();
    show(champions.length ? `已从客户端读取 ${champions.length} 名英雄。` : '暂时无法读取英雄列表；已保留本地映射，请启动英雄联盟客户端后刷新。', champions.length === 0);
  } catch {
    show('读取英雄列表失败；请确认英雄联盟客户端正在运行。', true);
  } finally {
    select.disabled = false;
  }
}

async function refreshDevices() {
  try {
    const allDevices = await navigator.mediaDevices.enumerateDevices();
    audioDevices = allDevices;
    renderSystemAudioWarning();
    const devices = allDevices.filter(device => device.kind === 'audiooutput');
    const inputs = allDevices.filter(device => device.kind === 'audioinput');
    const formal = $('outputDevice');
    const monitor = $('monitorDevice');
    const calibration = $('calibrationInput');
    formal.replaceChildren(new Option('请选择 CABLE Input', ''));
    monitor.replaceChildren(new Option('请选择真实耳机', ''));
    calibration.replaceChildren(new Option('使用所选真实麦克风', ''));
    for (const device of devices.filter(d => (!InternalAudio.isAlias(d.deviceId) && /^CABLE(?:-[A-D])? Input\b/i.test(d.label)))) {
      const label = device.label || '音频输出设备';
      formal.add(new Option(label, device.deviceId));
    }
    for (const device of MusicModel.physicalDevices(devices).filter(d => !InternalAudio.isAlias(d.deviceId))) monitor.add(new Option(device.label || '音频输出设备', device.deviceId));
    for (const device of inputs.filter(d => (!InternalAudio.isAlias(d.deviceId) && !InternalAudio.isVirtual(d.label)))) {
      const label = device.label || `音频输入设备 ${calibration.options.length}`;
      calibration.add(new Option(label, device.deviceId));
    }
    formal.value = MusicModel.matchDevice(devices.filter(d => /^CABLE(?:-[A-D])? Input\b/i.test(d.label)), settings.cableOutputDeviceId, settings.cableOutputDeviceName)?.deviceId || '';
    monitor.value = settings?.monitorDeviceId || '';
    if (!monitor.value) monitor.value = MusicModel.matchDevice(devices.filter(d => !InternalAudio.isVirtual(d.label)), settings.monitorDeviceId, settings.headphoneDeviceName)?.deviceId || '';
    const mic = $('internalMic');
    mic.replaceChildren(new Option('请选择真实麦克风', ''));
    for (const device of MusicModel.physicalDevices(inputs).filter(d => !InternalAudio.isAlias(d.deviceId))) mic.add(new Option(device.label, device.deviceId));
    mic.value = MusicModel.matchDevice(inputs.filter(d => !InternalAudio.isVirtual(d.label)), settings.internalMicDeviceId, settings.internalMicDeviceName)?.deviceId || '';
    calibration.value = inputs.some(device => device.deviceId === settings?.calibrationInputDeviceId)
      ? settings.calibrationInputDeviceId
      : '';
    calibration.value = mic.value;
    renderInternalStatus();
    return { outputs: devices, inputs };
  } catch {
    show('浏览器未能读取输出设备列表。', true);
    return { outputs: [], inputs: [] };
  }
}

async function measureSpeakingRms(stream, durationMs = 5000) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error('当前系统不支持音量分析。');
  const context = new AudioContextClass({ latencyHint: 'interactive' });
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);
  const frame = new Float32Array(analyser.fftSize);
  const levels = [];
  const peaks = [];
  const startedAt = performance.now();
  await context.resume();
  try {
    while (performance.now() - startedAt < durationMs) {
      analyser.getFloatTimeDomainData(frame);
      let energy = 0;
      let peak = 0;
      for (let i = 0; i < frame.length; i++) {
        energy += frame[i] * frame[i];
        peak = Math.max(peak, Math.abs(frame[i]));
      }
      levels.push(Math.sqrt(energy / frame.length));
      peaks.push(peak);
      const remaining = Math.max(1, Math.ceil((durationMs - (performance.now() - startedAt)) / 1000));
      $('calibrateVolume').textContent = `正常说话…${remaining}`;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  } finally {
    source.disconnect();
    await context.close();
  }
  const noiseFloor = percentile(levels, 0.15);
  const speech = levels.filter(level => level > Math.max(0.004, noiseFloor * 1.8));
  if (speech.length < 12) throw new Error('没有检测到足够的说话声音，请确认参考输入设备并重试。');
  return { rms: percentile(speech, 0.6), peak: percentile(peaks, 0.98) };
}

async function analyzeTrackRms(track) {
  if (!track?.path) throw new Error('请先保存一条音乐映射。');
  const encoded = await window.soundboard.readMappedAudio(track.path);
  const bytes = encoded instanceof Uint8Array ? encoded : new Uint8Array(encoded);
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const context = new AudioContextClass();
  try {
    const buffer = await context.decodeAudioData(data);
    const blockSize = 2048;
    const range = MusicModel.range(track, buffer.duration);
    const startSample = Math.floor(range.start * buffer.sampleRate);
    const endSample = Math.min(buffer.length, Math.ceil(range.end * buffer.sampleRate));
    const totalBlocks = Math.max(1, Math.ceil((endSample - startSample) / blockSize));
    const blockStep = Math.max(1, Math.floor(totalBlocks / 2400));
    const levels = [];
    for (let block = 0; block < totalBlocks; block += blockStep) {
      const start = startSample + block * blockSize;
      const end = Math.min(endSample, start + blockSize);
      let energy = 0;
      let count = 0;
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const samples = buffer.getChannelData(channel);
        for (let i = start; i < end; i++) {
          energy += samples[i] * samples[i];
          count++;
        }
      }
      const rms = count ? Math.sqrt(energy / count) : 0;
      if (rms > 0.003) levels.push(rms);
    }
    if (!levels.length) throw new Error('所选音乐几乎没有可分析的声音。');
    return percentile(levels, 0.6);
  } finally {
    await context.close();
  }
}

async function calibrateFixedVolume() {
  const key = championKey() || currentChampion?.name || '';
  const track = (editorMode === 'public' ? MusicModel.slots(settings.publicTracks) : tracksFor(key)).find(Boolean);
  if (!track) return show('请先在公共池或所选英雄中保存一条音乐，再进行校准。', true);
  const button = $('calibrateVolume');
  button.disabled = true;
  button.textContent = '准备麦克风…';
  let stream;
  try {
    if (!player.paused) pauseActive('已暂停音乐，避免影响说话音量校准。');
    previewPlayer.pause();
    // The first short request reveals device labels after the user grants local permission.
    {
      InternalAudio.validate(internalSelection());
      $('calibrationInput').value = $('internalMic').value;

    }
    const deviceId = $('calibrationInput').value;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });
    show('请保持平常 QQ 通话的说话音量，连续说话 5 秒。');
    const [voice, trackRms] = await Promise.all([measureSpeakingRms(stream), analyzeTrackRms(track)]);
    const currentMicGainDb = 0;
    const desiredGainIncreaseDb = 20 * Math.log10(0.08 / Math.max(voice.rms, 0.001));
    const peakHeadroomDb = 20 * Math.log10(0.75 / Math.max(voice.peak, 0.01));
    const gainIncreaseDb = Math.max(0, Math.min(desiredGainIncreaseDb, peakHeadroomDb));
    const micGainDb = Math.max(-3, Math.min(12, currentMicGainDb + gainIncreaseDb));
    const boostedVoiceRms = voice.rms * Math.pow(10, (micGainDb - currentMicGainDb) / 20);
    const fixedVolume = Math.max(0.1, Math.min(0.7, boostedVoiceRms / trackRms));
    button.textContent = '正在保存固定值…';
    const micResult = await window.soundboard.applyMicGain(micGainDb);
    if (!micResult.ok) throw new Error(`麦克风增益应用失败：${micResult.error || '请用管理员快捷方式重启后重试。'}`);
    const result = await window.soundboard.saveSettings({
      musicVolume: fixedVolume,
      internalMicGainDb: micResult.micGainDb
    });
    if (!result.ok) throw new Error(result.error || '保存音量失败。');
    settings = result.settings;
    internalRoute?.setGain(settings.internalMicGainDb);
    updateVolumeDisplay(settings.musicVolume);
    applyWeakNetworkGraph();
    monitorPlayer.volume = settings.monitorVolume;
    previewPlayer.volume = settings.monitorVolume;
    renderAudioBackend();
    show(`校准完成：麦克风 ${Number(settings.internalMicGainDb).toFixed(1)} dB，音乐 ${Math.round(settings.musicVolume * 100)}%。`);
  } catch (error) {
    show(error?.message || '音量校准失败。', true);
  } finally {
    if (stream) stream.getTracks().forEach(trackItem => trackItem.stop());
    button.disabled = false;
    button.textContent = '麦克风和音乐校准';
  }
}

async function init() {
  settings = MusicModel.migrate(await window.soundboard.getSettings());
  if (settings.audioPreview) {
    document.title = `英雄音乐台 · 混音测试版 ${settings.previewBuild || ''}`;
    const label = document.querySelector('.tb-title span');
    label.textContent = '英雄音乐台 · 测试版'; label.title = document.title;
  }
  $('wizardBackend').value = settings.audioBackend;
  renderLibraryStatus();
  $('musicLibrary').open = !MusicModel.slots(settings.publicTracks).some(Boolean) && !Object.values(settings.mappings || {}).some(value => MusicModel.slots(value).some(Boolean));
  $('weakNetworkMode').checked = weakEnabled();
  $('loudnessStabilizer').checked = stabilizerEnabled();
  applyModeSwitchState();
  updateVolumeDisplay(settings.musicVolume);
  renderAudioBackend();
  hotkeyDisplays();
  if (settings.lockfilePath) $('lockfileInfo').textContent = `当前 lockfile：${settings.lockfilePath}`;
  const { outputs: devices } = await refreshDevices();
  await refreshChampions();  // 启动时补齐自动昵称表（Data Dragon 本名），命中后重渲染搜索列表
  window.soundboard.getChampionNicknames(false).then(map => {
    if (map && Object.keys(map).length) {
      championNicknames = map;
      renderChampionOptions($('championSearch').value);
      renderManualOptions($('manualChampionSearch').value);
    }
  }).catch(() => { /* 离线时用上次缓存，无缓存则退化为称号+手工昵称表 */ });

  await setOutputDevices();
  applyMappingView();

  window.soundboard.onToggle(payload => playSlot(playbackChampionKey(), Math.max(0, Math.min(2, Number(payload?.slot) || 0))));
  window.soundboard.onRestart(() => restartCurrentPlayback());
  window.soundboard.onPause(() => togglePausePlayback());
  window.soundboard.onChampion(champion => {
    currentChampion = champion;
    if (!champion) { applyManualView(); renderLibraryStatus(); return; }
    ensureChampionOption(champion.name);
    $('currentChampion').textContent = champion.name;
    $('championHint').textContent = champion.locked
      ? `已锁定；${slotAccelerator(0)} / ${slotAccelerator(1)} / ${slotAccelerator(2)} 会播放对应音乐。`
      : '英雄预选中；锁定后也会自动更新。';
    applyManualView();
    renderLibraryStatus();
    if (champion.locked || champion.inGame) recordRecent(champion.name);
  });
  window.soundboard.onLcuStatus(status => {
    $('lcuBadge').textContent = status.text;
    $('lcuBadge').classList.toggle('muted', !status.connected);
  });
  // All listeners are wired; ask the main process to replay the current state
  // in case it was broadcast before we could receive it.
  await window.soundboard.rendererReady();
  maybeShowSetupWizard();
  document.documentElement.dataset.ready = 'true';
}

// —— 初次配置向导 ——
function needsSetup() {
  return !settings.setupDone || !settings.internalMicDeviceName || !settings.cableOutputDeviceId || !settings.monitorDeviceId;
}

function waitForResult(promise, timeoutMs, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]).finally(() => clearTimeout(timer));
}
let wizardOpening = false;
async function maybeShowSetupWizard(force = false, backend = settings.audioBackend) {
  if ((!force && !needsSetup()) || wizardOpening) return;
  wizardOpening = true;
  $('setupWizard').hidden = false;
  $('wizardResult').textContent = ''; $('wizardResult').style.color = '';
  $('wizardBackend').value = backend;
  renderWizardBackend();
  $('wizardDeviceStatus').textContent = '正在读取设备；麦克风授权等待最多 8 秒。';
  try {
    // Always release a late permission result, even after the visible timeout.
    const probe = navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => { stream.getTracks().forEach(track => track.stop()); });
    await waitForResult(probe, 8000, '麦克风授权尚未完成。');
  } catch { /* enumerate any device labels already available */ }
  try {
    wizardDeviceLists = await waitForResult(refreshDevices(), 8000, '读取设备超时，请检查连接后刷新。');
    fillWizardDeviceOptions();
  } catch (error) { $('wizardDeviceStatus').textContent = error.message; }
  finally { wizardOpening = false; }
}

let wizardDeviceLists = { outputs: [], inputs: [] };

function fillWizardDeviceOptions() {
  const headphone = $('wizardHeadphone');
  const microphone = $('wizardMicrophone');
  const previousHeadphone = headphone.value, previousMicrophone = microphone.value, previousCable = $('wizardCable').value;
  headphone.replaceChildren(new Option('请选择耳机', ''));
  const outputs = MusicModel.physicalDevices(wizardDeviceLists.outputs);
  outputs.forEach(device => headphone.add(new Option(device.label, device.label)));
  microphone.replaceChildren(new Option('请选择麦克风', ''));
  const inputs = MusicModel.physicalDevices(wizardDeviceLists.inputs);
  inputs.forEach(device => microphone.add(new Option(device.label, device.label)));
  if (settings.headphoneDeviceName) headphone.value = MusicModel.deviceName(settings.headphoneDeviceName);
  const micName = settings.internalMicDeviceName || settings.microphoneDeviceName;
  if (micName) microphone.value = MusicModel.deviceName(micName);
  if (outputs.some(d => d.label === previousHeadphone)) headphone.value = previousHeadphone;
  if (inputs.some(d => d.label === previousMicrophone)) microphone.value = previousMicrophone;
  const cable = $('wizardCable');
  cable.replaceChildren(new Option('请选择 CABLE Input', ''));
  for (const device of wizardDeviceLists.outputs.filter(d => !InternalAudio.isAlias(d.deviceId) && /^CABLE(?:-[A-D])? Input\b/i.test(d.label))) cable.add(new Option(device.label, device.deviceId));
  cable.value = [...cable.options].find(d => d.value === settings.cableOutputDeviceId || (d.value && d.text === settings.cableOutputDeviceName))?.value || (cable.options.length === 2 ? cable.options[1].value : '');
  if ([...cable.options].some(d => d.value === previousCable && previousCable)) cable.value = previousCable;
  renderWizardBackend();
  $('wizardDeviceStatus').textContent = outputs.length && inputs.length ? '设备已就绪，请选择日常使用的物理耳机和麦克风。' : '设备名称不可用，请检查麦克风权限和连接后刷新。';
}

player.addEventListener('ended', () => {
  finishActive();
});

setInterval(() => {
  if (player.paused || monitorPlayer.paused) return;
  if (Math.abs(player.currentTime - monitorPlayer.currentTime) > 0.12) {
    try { monitorPlayer.currentTime = player.currentTime; } catch { /* media not ready */ }
  }
}, 500);

$('useDetected').onclick = () => {
  if (!currentChampion) return show('尚未检测到英雄。', true);
  setEditorMode('champion', currentChampion.name);
};
$('editPublic').onclick = () => setEditorMode('public');
$('editChampion').onclick = () => setEditorMode('champion');
$('quickConfigure').onclick = () => setEditorMode('champion', playbackChampionKey());
$('playbackMode').onchange = async () => {
  const result = await window.soundboard.saveSettings({ playbackMode: $('playbackMode').value });
  if (result.ok) { settings = result.settings; renderLibraryStatus(); applyManualView(); }
};
$('manualChampion').onchange = () => setManualChampion($('manualChampion').value);
$('clearManualChampion').onclick = () => setManualChampion('');
$('restoreAuto').onclick = () => setManualChampion('');
$('manualToggle').onclick = () => {
  const expanded = $('manualPanel').hidden;
  $('manualPanel').hidden = !expanded;
  $('manualToggle').setAttribute('aria-expanded', String(expanded));
  if (expanded) $('manualChampionSearch').focus();
};

// 自绘标题栏窗口控制
$('winMinimize').onclick = () => window.soundboard.windowControl('minimize');
$('winMaximize').onclick = () => window.soundboard.windowControl('maximize');
$('winClose').onclick = () => window.soundboard.windowControl('close');
window.soundboard.onMaximizeState(maximized => {
  $('winMaximize').textContent = maximized ? '\u2750' : '\u25A1';
});

// 关闭确认（应用内模态框，替代原生对话框）
window.soundboard.onConfirmClose(() => { $('closeModal').hidden = false; });
function answerClose(action) {
  const remember = action === 'tray' || action === 'exit' ? $('closeRemember').checked : false;
  $('closeModal').hidden = true;
  window.soundboard.submitCloseChoice(action, remember);
}
$('closeToTray').onclick = () => answerClose('tray');
$('closeExit').onclick = () => answerClose('exit');
// 取消：不执行任何操作，窗口保持打开；Esc 或点击遮罩空白处同样取消
$('closeCancelX').onclick = () => answerClose('cancel');
$('closeModal').addEventListener('mousedown', event => {
  if (event.target === $('closeModal')) answerClose('cancel');
});
window.addEventListener('keydown', event => {
  if (!$('closeModal').hidden && event.key === 'Escape') answerClose('cancel');
});

// 向导交互
$('reconfigureAudio').onclick = () => maybeShowSetupWizard(true);
$('wizardDismiss').onclick = () => { if (!$('wizardFinish').disabled) { $('setupWizard').hidden = true; renderAudioBackend(); } };
$('wizardRefreshDevices').onclick = async () => {
  $('wizardDeviceStatus').textContent = '正在刷新设备…';
  try { wizardDeviceLists = await waitForResult(refreshDevices(), 8000, '设备读取超时，请重试。'); fillWizardDeviceOptions(); }
  catch (error) { $('wizardDeviceStatus').textContent = error.message; }
};
$('wizardFinish').onclick = async () => {
  if ($('wizardFinish').disabled) return;
  const resultBox = $('wizardResult');
  const headphoneDeviceName = $('wizardHeadphone').value;
  const microphoneDeviceName = $('wizardMicrophone').value;
  if (!headphoneDeviceName || !microphoneDeviceName) {
    resultBox.style.color = '#b42335';
    resultBox.textContent = '请先在②中选择耳机和麦克风。';
    return;
  }
  if ($('wizardBackend').value === 'internal') {
    const findPhysical = (list, name) => MusicModel.physicalDevices(list).find(d => d.label === MusicModel.deviceName(name) && !InternalAudio.isAlias(d.deviceId));
    const mic = findPhysical(wizardDeviceLists.inputs, microphoneDeviceName);
    const monitor = findPhysical(wizardDeviceLists.outputs, headphoneDeviceName);
    const cable = wizardDeviceLists.outputs.find(d => d.deviceId === $('wizardCable').value);
    try { InternalAudio.validate({ mic, monitor, cable }); }
    catch (error) { resultBox.textContent = error.message; resultBox.style.color = '#b42335'; return; }
    $('wizardFinish').disabled = true; $('wizardDismiss').disabled = true; $('wizardBackend').disabled = true;
    pauseActive(); cancelInternalAudio();
    try {
      resultBox.textContent = '正在保存所选设备并连接麦克风；Windows 默认设备保持不变…';
      const result = await waitForResult(window.soundboard.wizardComplete({ audioBackend: 'internal', headphoneDeviceName, microphoneDeviceName, internalMicDeviceId: mic.deviceId, monitorDeviceId: monitor.deviceId, cableOutputDeviceId: cable.deviceId, cableOutputDeviceName: cable.label }), 40000, '保存设备超时，请重试。');
      if (!result.ok) throw Error(result.error || '保存音频方案失败。');
      settings = MusicModel.migrate(result.settings);
      await waitForResult(refreshDevices(), 8000, '读取设备超时。');
      renderAudioBackend();
      if (!await connectInternalAudio()) throw Error($('internalAudioStatus').textContent || '连接音频失败。');
      const ready = await window.soundboard.saveSettings({ setupDone: true });
      if (!ready.ok) throw Error(ready.error || '保存完成状态失败。');
      settings = ready.settings; $('setupWizard').hidden = true;
      show('内部混音已连接。QQ 麦克风选 CABLE Output、扬声器选真实耳机；Windows 默认设备未改动。');
    } catch (error) { cancelInternalAudio(); renderInternalStatus(error.message, true); resultBox.textContent = `配置失败：${error.message}`; resultBox.style.color = '#b42335'; }
    finally { $('wizardFinish').disabled = false; $('wizardDismiss').disabled = false; $('wizardBackend').disabled = false; }
    return;
  }
};
$('refreshChampions').onclick = refreshChampions;
$('championSearch').oninput = () => renderChampionOptions($('championSearch').value);
$('manualChampionSearch').oninput = () => renderManualOptions($('manualChampionSearch').value);
$('championInput').onchange = async () => {
  if ((editorDirty || segmentDraftDirty) && !await confirmAction('要切换到另一位英雄的音乐配置吗？')) {
    $('championInput').value = editorSelection;
    return;
  }
  editorDirty = false;
  segmentDraftDirty = false;
  applyMappingView();
};

for (let slot = 0; slot < 3; slot++) {
  $(`editSegment${slot + 1}`).onclick = () => openSegment(slot);
  $(`chooseTrack${slot + 1}`).onclick = async () => {
    const track = await window.soundboard.chooseAudio();
    if (track) {
      selectedTracks[slot] = track;
      editorDirty = true;
      updateTrackRows();
      $(`trackLabel${slot + 1}`).value = track.name;
      show(`已选择 ${slotAccelerator(slot)} 音乐；点击“保存三条映射”后生效。`);
    }
  };
  $(`playPreview${slot + 1}`).onclick = () => previewTrack(slot);
  $(`clearTrack${slot + 1}`).onclick = () => {
    selectedTracks[slot] = null;
    editorDirty = true;
    updateTrackRows();
    $(`trackLabel${slot + 1}`).value = '';
    show(`已清空 ${slotAccelerator(slot)}；点击“保存三条映射”后生效。`);
  };
}

for (let slot = 0; slot < 3; slot++) $(`editHotkey${slot}`).onclick = () => startHotkeyCapture(slot);
$('editHotkeyPause').onclick = () => startHotkeyCapture('pause');
$('captureConfirm').onclick = confirmHotkeyCapture;
$('captureCancel').onclick = cancelHotkeyCapture;

$('saveMapping').onclick = async () => {
  if (segmentDraftDirty && segmentSlot >= 0) {
    try { selectedTracks[segmentSlot] = readSegment(); segmentDraftDirty = false; }
    catch (error) { return show(error.message, true); }
  }
  const key = championKey();
  if (!key && editorMode !== 'public') return show('请先选择英雄。', true);
  const mappings = { ...settings.mappings };
  if (selectedTracks.some(Boolean)) mappings[key] = [selectedTracks[0] || null, selectedTracks[1] || null, selectedTracks[2] || null];
  else delete mappings[key];
  const result = await window.soundboard.saveSettings(editorMode === 'public' ? { publicTracks: selectedTracks.slice() } : { mappings });
  if (result.ok) {
    settings = result.settings;
    editorDirty = false;
    applyMappingView();
    renderLibraryStatus();
    show('三条音乐映射已保存。');
  } else show(result.error, true);
};

$('removeMapping').onclick = async () => {
  const key = championKey();
  if (!key && editorMode !== 'public') return;
  if (!await confirmAction(editorMode === 'public' ? '清空公共池的三段音乐配置？' : `移除 ${key} 的全部音乐配置？`, '移除音乐配置', '确认移除', '只移除应用中的配置，原音频文件会保留。')) return;
  const mappings = { ...settings.mappings };
  delete mappings[key];
  const result = await window.soundboard.saveSettings(editorMode === 'public' ? { publicTracks: [null, null, null] } : { mappings });
  if (result.ok) {
    settings = result.settings;
    editorDirty = false;
    applyMappingView();
    renderLibraryStatus();
    show(editorMode === 'public' ? '公共音乐池已清空。' : '该英雄的全部音乐映射已移除。');
  } else show(result.error, true);
};

$('refreshDevices').onclick = async () => { await refreshDevices(); await setOutputDevices(); };
$('musicVolume').oninput = () => {
  const musicVolume = Number($('musicVolume').value) / 100;
  settings.musicVolume = musicVolume;
  updateVolumeDisplay(musicVolume);
  applyWeakNetworkGraph();
  if (!qqAudioGraph) player.volume = musicVolume;
};
$('musicVolume').onchange = async () => {
  const musicVolume = Number($('musicVolume').value) / 100;
  const result = await window.soundboard.saveSettings({ musicVolume });
  if (result.ok) {
    settings = result.settings;
    updateVolumeDisplay(settings.musicVolume);
    show(`音乐音量已固定为 ${Math.round(settings.musicVolume * 100)}%。`);
  } else show(result.error, true);
};
$('calibrationInput').disabled = true;
$('outputDevice').onchange = async () => {
  const result = await window.soundboard.saveSettings({ cableOutputDeviceId: $('outputDevice').value, cableOutputDeviceName: $('outputDevice').selectedOptions[0]?.text || '' });
  if (result.ok) { settings = result.settings; await setOutputDevices(); show('QQ 音乐输出设备已保存。'); }
  else show(result.error, true);
};
$('monitorDevice').onchange = async () => {
  const result = await window.soundboard.saveSettings({ monitorDeviceId: $('monitorDevice').value });
  if (result.ok) { settings = result.settings; await setOutputDevices(); show('耳机监听设备已保存。'); }
  else show(result.error, true);
};
function applyModeSwitchState() {
  const weak = $('weakNetworkMode').checked;
  const stab = $('loudnessStabilizer').checked;
  $('loudnessStabilizer').disabled = weak;
  $('weakNetworkMode').disabled = stab;
  if (weak && stab) $('loudnessStabilizer').checked = false; // 双开残留时弱网优先，显示同步
}

$('weakNetworkMode').onchange = async () => {
  const weakNetworkMode = $('weakNetworkMode').checked;
  // 互斥：开启弱网模式时自动停用响度稳定器
  const extra = weakNetworkMode && $('loudnessStabilizer').checked ? { loudnessStabilizer: false } : {};
  if (extra.loudnessStabilizer === false) $('loudnessStabilizer').checked = false;
  const changes = { internalWeakNetworkMode: weakNetworkMode, ...(extra.loudnessStabilizer === false ? { internalLoudnessStabilizer: false } : {}) };
  const result = await window.soundboard.saveSettings(changes);
  if (result.ok) {
    settings = result.settings;
    applyWeakNetworkGraph();
    applyModeSwitchState();
    show(weakNetworkMode
      ? 'QQ 弱网模式已开启：仅处理发送的 BGM，耳机监听和人声不受影响；不能修复网络丢包。'
      : 'QQ 弱网模式已关闭：发送到 QQ 的音乐恢复原始频段和声道。');
  } else {
    $('weakNetworkMode').checked = !weakNetworkMode;
    show(result.error, true);
  }
};
$('loudnessStabilizer').onchange = async () => {
  const loudnessStabilizer = $('loudnessStabilizer').checked;
  // 互斥：开启响度稳定器时自动停用弱网模式
  const extra = loudnessStabilizer && $('weakNetworkMode').checked ? { weakNetworkMode: false } : {};
  if (extra.weakNetworkMode === false) $('weakNetworkMode').checked = false;
  const changes = { internalLoudnessStabilizer: loudnessStabilizer, ...(extra.weakNetworkMode === false ? { internalWeakNetworkMode: false } : {}) };
  const result = await window.soundboard.saveSettings(changes);
  if (result.ok) {
    settings = result.settings;
    applyWeakNetworkGraph();
    applyModeSwitchState();
    show(loudnessStabilizer
      ? '响度稳定器已开启：把安静段抬高、电平稳住，送 QQ 的音乐频段不变（弱网模式已停用）。'
      : '响度稳定器已关闭。');
  } else {
    $('loudnessStabilizer').checked = !loudnessStabilizer;
    show(result.error, true);
  }
};
$('chooseLockfile').onclick = async () => {
  const file = await window.soundboard.chooseLockfile();
  if (file) { $('lockfileInfo').textContent = `当前 lockfile：${file}`; show('已保存 lockfile 路径。'); }
};

$('segmentSeek').oninput = () => {
  const position = Number($('segmentSeek').value);
  $('segmentPosition').textContent = formatTime(position);
  if (segmentSlot >= 0 && MusicModel.same(previewTrackSnapshot, readSegment()) && previewPlayer.readyState >= 1) previewPlayer.currentTime = position;
};
$('segmentStartRange').oninput = () => dragSegmentBoundary(true);
$('segmentEndRange').oninput = () => dragSegmentBoundary(false);
$('segmentStart').oninput = $('segmentEnd').oninput = () => { segmentDraftDirty = true; updateSegmentDisplay(); };
$('segmentClose').onclick = () => { $('segmentEditor').hidden = true; previewPlayer.pause(); };
$('segmentPreview').onclick = async () => {
  try {
    const track = readSegment();
    if (!previewPlayer.paused && MusicModel.same(previewTrackSnapshot, track)) {
      previewPlayer.pause(); $('segmentPreview').textContent = '继续试听'; return;
    }
    const resume = MusicModel.same(previewTrackSnapshot, track) && !previewFinished && !previewPlayer.ended;
    await previewTrack(segmentSlot, track, resume);
    $('segmentPreview').textContent = previewPlayer.paused ? '试听完整片段' : '暂停试听';
  }
  catch (error) { show(error.message, true); }
};
$('segmentApply').onclick = () => {
  try {
    selectedTracks[segmentSlot] = readSegment();
    segmentDraftDirty = false;
    editorDirty = true;
    updateTrackRows();
    $('segmentEditor').hidden = true;
    previewPlayer.pause();
    show('片段范围已应用；点击“保存三条映射”即可保存。');
  } catch (error) { show(error.message, true); }
};
$('playCurrent').onclick = () => activeTrack ? togglePausePlayback() : playSlot(playbackChampionKey(), 0);
$('monitorVolume').oninput = () => {
  settings.monitorVolume = Number($('monitorVolume').value) / 100;
  monitorPlayer.volume = settings.monitorVolume;
  previewPlayer.volume = settings.monitorVolume;
  $('monitorVolumeValue').textContent = `${Math.round(settings.monitorVolume * 100)}%`;
};
$('monitorVolume').onchange = async () => {
  const result = await window.soundboard.saveSettings({ monitorVolume: settings.monitorVolume });
  if (result.ok) { settings = result.settings; show('耳机监听音量已保存。'); }
  else show(result.error || '保存监听音量失败。', true);
};
let outputTest = null;
function stopOutputTest() {
  if (internalTestTone) { const tone = internalTestTone; internalTestTone = null; try { tone.stop(); } catch {} }
  if (outputTest) { outputTest.pause(); outputTest.removeAttribute('src'); outputTest.load(); outputTest = null; }
}
async function testOutput(virtual) {
  stopOutputTest();
  if (!player.paused) pauseActive('已暂停音乐，开始输出测试。');
  previewPlayer.pause();
  const id = virtual ? $('outputDevice').value : $('monitorDevice').value;
  if (virtual) {
    if (!await setOutputDevices() || !await connectInternalAudio()) return;
    // Tone joins the same protected mix as BGM; it never enters the monitor.
    const context = qqAudioGraph.context, oscillator = context.createOscillator(), gain = context.createGain();
    oscillator.frequency.value = 997; gain.gain.value = 0;
    gain.gain.setTargetAtTime(Math.min(0.08, settings.musicVolume || 0), context.currentTime, 0.01);
    gain.gain.setTargetAtTime(0, context.currentTime + 0.8, 0.02);
    oscillator.connect(gain).connect(internalRoute.mix); oscillator.start(); oscillator.stop(context.currentTime + 1);
    internalTestTone = oscillator;
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); if (internalTestTone === oscillator) { internalTestTone = null; $('outputStatus').textContent = '混合输出测试完成，麦克风仍在传输。'; } };
    $('outputStatus').textContent = '短测试音已发送到 CABLE Output，请让 QQ 对方确认；不回听到耳机。';
    return;
  }
  if (!audioDevices.some(d => d.kind === 'audiooutput' && d.deviceId === id && !InternalAudio.isAlias(id) && !InternalAudio.isVirtual(d.label))) return show('请先选择真实耳机。', true);
  const audio = document.createElement('audio');
  outputTest = audio;
  audio.src = settings.testTrackUrl;
  audio.volume = virtual ? settings.musicVolume : settings.monitorVolume;
  if (!await setSink(audio, id, '测试设备不可用，请刷新设备并重新选择。')) { stopOutputTest(); return; }
  try {
    await audio.play();
    if (outputTest !== audio) { audio.pause(); return; }
    $('outputStatus').textContent = virtual ? '测试音已送入虚拟设备，请在 QQ 通话中确认对方能听见。' : '耳机测试音正在播放。';
    audio.onended = () => { if (outputTest === audio) { stopOutputTest(); $('outputStatus').textContent = '测试音播放完毕。'; } };
  } catch (error) { stopOutputTest(); show(`输出测试失败：${error.message}`, true); }
}
$('testMonitor').onclick = () => testOutput(false);
$('testVirtual').onclick = () => testOutput(true);
$('stopOutputTest').onclick = stopOutputTest;
$('confirmProceed').onclick = () => answerConfirmation(true);
$('confirmCancel').onclick = $('confirmClose').onclick = () => answerConfirmation(false);
$('confirmModal').onmousedown = event => { if (event.target === $('confirmModal')) answerConfirmation(false); };
window.addEventListener('keydown', event => {
  if (!confirmationResolver) return;
  if (event.key === 'Escape') { event.preventDefault(); answerConfirmation(false); }
  if (event.key === 'Tab') {
    const buttons = [...$('confirmModal').querySelectorAll('button')];
    const first = buttons[0], last = buttons[buttons.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});
navigator.mediaDevices.addEventListener('devicechange', async () => {
  {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const selected = internalRoute?.running ? internalRoute.devices : internalPendingDevices;
    if (selected && ['mic', 'cable', 'monitor'].some(k => !devices.some(d => d.deviceId === selected[k].deviceId))) {
      pauseActive(); stopOutputTest(); cancelInternalAudio();
      await refreshDevices(); renderInternalStatus('所选设备已断开，已停止混音；检查设备后重新连接。', true); return;
    }
    await refreshDevices(); return;
  }

});

function internalSelection() {
  const find = id => audioDevices.find(d => d.deviceId === $(id).value);
  return { mic: find('internalMic'), cable: find('outputDevice'), monitor: find('monitorDevice') };
}
function renderInternalStatus(message, error = false) {
  const running = Boolean(internalRoute?.running);
  $('internalAudioStatus').textContent = message || (internalConnecting ? '正在连接…' : running ? (internalRoute.muted ? '人声已静音 · BGM 继续发送' : '人声持续传输 · 暂停 BGM 不影响说话') : '尚未采集麦克风 · 播放键也可开启连接');
  $('internalAudioStatus').classList.toggle('audio-error', error);
  $('connectInternal').disabled = internalConnecting || running;
  $('disconnectInternal').disabled = !running && !internalConnecting;
  $('muteInternal').disabled = !running;
  $('muteInternal').textContent = internalRoute?.muted ? '取消麦克风静音' : '麦克风静音';
  if (!running) $('internalAudioHint').textContent = 'QQ 麦克风选 CABLE Output，扬声器选真实耳机。暂停音乐不停止人声；退出应用或断开后，QQ 需切回真实麦克风。使用耳机，避免手机测试或扬声器造成回声。';
  for (const id of ['internalMic', 'outputDevice', 'monitorDevice', 'authorizeAudio', 'refreshDevices']) $(id).disabled = (running || internalConnecting);
}
function renderAudioBackend() {
  $('audioBackend').value = settings.audioBackend;
  $('internalAudioPanel').hidden = false; $('internalExitHint').hidden = false;
  $('audioBackendHint').textContent = 'LBGM 混合真实麦克风与 BGM → CABLE；耳机只听 BGM。不更改 Windows 默认设备，启动时不自动采集，连接后最小化仍继续传输。';
  $('internalMicGain').value = settings.internalMicGainDb ?? 0;
  $('internalMicGainValue').textContent = `${settings.internalMicGainDb ?? 0} dB`;
  $('weakNetworkMode').checked = weakEnabled(); $('loudnessStabilizer').checked = stabilizerEnabled(); applyModeSwitchState();
  $('calibrationHint').textContent = `固定结果：人声增益 ${Number(settings.internalMicGainDb).toFixed(1)} dB，音乐 ${Math.round(settings.musicVolume * 100)}%。仅主动校准时更新。`;
  renderInternalStatus();
  renderSystemAudioWarning();
}
function renderSystemAudioWarning() {
  $('systemAudioWarning').hidden = !audioDevices.some(d => d.kind === 'audiooutput' && ['default', 'communications'].includes(d.deviceId) && InternalAudio.isVirtual(MusicModel.deviceName(d.label)));
}
async function connectInternalAudio() {
  if (internalConnecting) { show('正在连接麦克风，请稍候再播放。'); return false; }
  try { InternalAudio.validate(internalSelection()); } catch (error) { renderInternalStatus(error.message, true); show(error.message, true); return false; }
  if (internalRoute?.running) return true;
  const ticket = ++internalConnectionTicket;
  const selected = internalSelection();
  const current = () => ticket === internalConnectionTicket;
  internalConnecting = true; internalPendingDevices = selected; renderInternalStatus();
  try {
    if (!await setOutputDevices()) throw Error($('outputStatus').textContent);
    if (!current()) return false;
    if (!await ensureQqAudioGraph()) throw Error('无法建立音乐混音引擎。');
    if (!current()) return false;

    if (!internalRoute) internalRoute = new InternalAudio.Route(qqAudioGraph.context, qqAudioGraph.outputGain, message => { cancelInternalAudio(); pauseActive(); stopOutputTest(); renderInternalStatus(message, true); show(message, true); });
    internalRoute.setGain(settings.internalMicGainDb ?? 0);
    const connected = await waitForResult(internalRoute.connect(selected), 12000, '连接超时，请检查麦克风权限、CABLE 和设备占用。');
    if (!current() || !connected || !internalRoute.running) return false;
    const generation = internalRoute.generation;
    const saved = await window.soundboard.saveSettings({ internalMicDeviceId: selected.mic.deviceId, internalMicDeviceName: selected.mic.label, cableOutputDeviceId: selected.cable.deviceId, cableOutputDeviceName: selected.cable.label, monitorDeviceId: selected.monitor.deviceId });
    if (!current() || !internalRoute.running || internalRoute.generation !== generation) return false;
    if (!saved.ok) throw Error(saved.error || '保存设备失败。'); settings = saved.settings;
    return true;
  } catch (error) { if (current()) { internalRoute?.stop(); renderInternalStatus(error.message, true); show(error.message, true); } return false; }
  finally { if (ticket === internalConnectionTicket) { internalConnecting = false; internalPendingDevices = null; const message = $('internalAudioStatus').classList.contains('audio-error') ? $('internalAudioStatus').textContent : ''; renderInternalStatus(message, Boolean(message)); } }
}
function cancelInternalAudio() {
  ++internalConnectionTicket; internalConnecting = false; internalPendingDevices = null; internalRoute?.stop();
}
function renderWizardBackend() {
  const internal = $('wizardBackend').value === 'internal';
 $('wizardCableStep').hidden = !internal; $('wizardCableRow').hidden = !internal;
  $('wizardCableStatus').textContent = wizardDeviceLists.outputs.some(d => /^CABLE(?:-[A-D])? Input\b/i.test(d.label)) && wizardDeviceLists.inputs.some(d => /^CABLE(?:-[A-D])? Output\b/i.test(d.label)) ? '已检测到 CABLE Input / Output。' : '尚未检测到完整的 VB-CABLE 输入与输出，请安装、重启后刷新。';
  $('wizardSetupHint').textContent = '保存设备并启动内部混音。不更改 Windows 默认设备。QQ 麦克风手动选 CABLE Output，扬声器选真实耳机。';
}
let internalTestTone = null;
$('connectInternal').onclick = () => connectInternalAudio();
$('disconnectInternal').onclick = () => { pauseActive(); stopOutputTest(); cancelInternalAudio(); renderInternalStatus('已断开。QQ 请切回真实麦克风；重新播放或点击连接可以恢复。'); };
$('muteInternal').onclick = () => { if (internalRoute?.running) internalRoute.setMuted(!internalRoute.muted); renderInternalStatus(); };
$('internalMic').onchange = async () => { const selected = internalSelection().mic; if (!selected) return; const saved = await window.soundboard.saveSettings({ internalMicDeviceId: selected.deviceId, internalMicDeviceName: selected.label }); if (saved.ok) { settings = saved.settings; $('calibrationInput').value = selected.deviceId; } };
$('internalMicGain').oninput = () => { const gain = Number($('internalMicGain').value); settings.internalMicGainDb = gain; internalRoute?.setGain(gain); $('internalMicGainValue').textContent = `${gain} dB`; };
$('internalMicGain').onchange = async () => { const saved = await window.soundboard.saveSettings({ internalMicGainDb: settings.internalMicGainDb }); if (saved.ok) { settings = saved.settings; renderAudioBackend(); } else show(saved.error, true); };
$('authorizeAudio').onclick = async () => { try { const permission = navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => stream.getTracks().forEach(t => t.stop())); await waitForResult(permission, 8000, '授权等待超时，请检查 Windows 麦克风隐私设置。'); await refreshDevices(); } catch (error) { renderInternalStatus(error.message, true); } };
$('audioBackend').onchange = () => maybeShowSetupWizard(true, $('audioBackend').value);
$('changeAudioBackend').onclick = () => maybeShowSetupWizard(true, $('audioBackend').value);

$('cableDownload').onclick = () => window.soundboard.cableHelp();
$('openWindowsSound').onclick = () => window.soundboard.openWindowsSound();
setInterval(() => {
  const levels = internalRoute?.running ? internalRoute.levels() : { mic: 0, music: 0, mix: 0 };
  $('internalMicMeter').value = levels.mic; $('internalMusicMeter').value = levels.music; $('internalMixMeter').value = levels.mix;
  if (internalRoute?.running) {
    const diagnostics = internalRoute.diagnostics(levels);
    $('internalAudioHint').textContent = levels.mic >= 0.95 || levels.music >= 0.95 ? '某一路接近满幅，请调低对应增益或音量，避免失真。' : `${diagnostics.sampleRate} Hz · 本地基础/输出缓冲 ${diagnostics.baseLatencyMs.toFixed(1)}/${diagnostics.outputLatencyMs.toFixed(1)} ms（非 QQ 端到端延迟）。QQ 输入 CABLE Output、输出真实耳机。暂停 BGM 不停止人声；退出后需切回真实麦克风。`;
  }
}, 250);
window.addEventListener('beforeunload', () => { cancelInternalAudio(); stopOutputTest(); });

init().catch(error => show(`初始化失败：${error.message}`, true));
