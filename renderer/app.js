const $ = id => document.getElementById(id);
const player = $('player');
const qqOutputPlayer = $('qqOutputPlayer');
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
  player.pause(); qqOutputPlayer.pause(); monitorPlayer.pause();
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
  const weak = Boolean(settings?.weakNetworkMode);
  // 响度稳定器只在弱网模式关闭时生效（弱网模式自身含更强的压缩处理）。
  const stab = !weak && Boolean(settings?.loudnessStabilizer);
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
    const context = new AudioContextClass({ latencyHint: 'interactive' });
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
    const destination = context.createMediaStreamDestination();

    source.connect(bypassGain).connect(outputGain);
    source.connect(stabCompressor);
    stabCompressor.connect(stabMakeup);
    stabMakeup.connect(stabGain);
    stabGain.connect(outputGain);
    source.connect(highpass).connect(lowpass).connect(mono).connect(compressor).connect(weakGain).connect(outputGain);
    outputGain.connect(destination);
    qqOutputPlayer.srcObject = destination.stream;
    qqAudioGraph = { context, source, highpass, lowpass, mono, compressor, stabCompressor, stabMakeup, stabGain, bypassGain, weakGain, outputGain, destination };
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
  const formalId = $('outputDevice').value || settings.outputDeviceId || '';
  const monitorId = $('monitorDevice').value || settings.monitorDeviceId || '';
  const graphReady = await ensureQqAudioGraph();
  if (!formalId || formalId === 'default') {
    $('outputStatus').textContent = '未选择虚拟音频输出，请选择 Voicemeeter Input。';
    return false;
  }
  if (formalId === monitorId) {
    $('outputStatus').textContent = '语音与监听选择了同一设备，请将监听改为物理耳机。';
    return false;
  }
  const formalOk = await setSink(graphReady ? qqOutputPlayer : player, formalId, '无法连接“发送到 QQ”的输出设备。');
  const monitorOk = await setSink(monitorPlayer, monitorId, '无法连接耳机监听输出设备。');
  await setSink(previewPlayer, monitorId, '无法连接耳机试听输出设备。');
  $('outputStatus').textContent = `语音输出：${formalOk ? '已连接' : '连接失败'} · 耳机监听：${monitorOk ? '已连接' : '连接失败'}`;
  return formalOk && monitorOk;
}

function pauseActive(message) {
  player.pause();
  qqOutputPlayer.pause();
  monitorPlayer.pause();
  try { monitorPlayer.currentTime = player.currentTime; } catch { /* media not ready */ }
  window.soundboard.reportPlayback({
    ok: true,
    action: 'paused',
    key: activeKey,
    slot: activeSlot,
    track: activeTrack?.name || '',
    currentTime: player.currentTime,
    sinkId: qqOutputPlayer.sinkId || player.sinkId || '',
    monitorSinkId: monitorPlayer.sinkId || ''
  });
  show(message || `已暂停：${activeTrack?.name || '当前音乐'}。再次按键将从当前位置继续。`);
  renderPlaybackStatus();
}

async function startActive(resume = false) {
  if (!activeTrack?.url) return false;
  const output = await setOutputDevices();
  if (!output) return false;
  stopOutputTest();
  ++previewGeneration;
  previewPlayer.pause();
  applyWeakNetworkGraph();
  player.volume = qqAudioGraph ? 1 : (settings.musicVolume ?? 0.4);
  monitorPlayer.volume = settings.monitorVolume ?? settings.musicVolume ?? 0.13;
  try { monitorPlayer.currentTime = player.currentTime; } catch { /* media will align after loading */ }

  const playRequests = [player.play(), monitorPlayer.play()];
  if (qqAudioGraph) playRequests.push(qqOutputPlayer.play());
  const [formalResult, monitorResult, qqOutputResult] = await Promise.allSettled(playRequests);
  if (formalResult.status === 'rejected' || (qqAudioGraph && qqOutputResult?.status === 'rejected')) {
    player.pause();
    qqOutputPlayer.pause();
    monitorPlayer.pause();
    const reason = formalResult.status === 'rejected' ? formalResult.reason : qqOutputResult.reason;
    window.soundboard.reportPlayback({ ok: false, action: 'play-error', key: activeKey, slot: activeSlot, track: activeTrack.name, error: String(reason), sinkId: qqOutputPlayer.sinkId || player.sinkId || '' });
    show('无法将音乐发送到 QQ；请确认 Voicemeeter 正在运行。', true);
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
    weakNetworkMode: Boolean(settings.weakNetworkMode),
    sinkId: qqOutputPlayer.sinkId || player.sinkId || '',
    monitorSinkId: monitorPlayer.sinkId || '',
    monitorOk,
    src: player.src
  });
  const prefix = resume ? '已从暂停位置继续' : '正在播放';
  const weakText = settings.weakNetworkMode ? '，QQ 弱网模式' : '';
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
    qqOutputPlayer.pause();
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
    player.pause(); qqOutputPlayer.pause(); monitorPlayer.pause();
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
    player.pause(); qqOutputPlayer.pause(); monitorPlayer.pause();
    player.currentTime = activeRange.start;
    monitorPlayer.currentTime = activeRange.start;
    activeFinished = false;
    await startActive(false);
  } catch (error) {
    player.pause(); qqOutputPlayer.pause(); monitorPlayer.pause();
    show(error.message || '重新播放失败。', true);
  } finally { playbackBusy = false; }
}

async function previewTrack(slot, override = null, resumeOverride = false) {
  const generation = ++previewGeneration;
  const track = override || selectedTracks[slot];
  if (!track?.url) return show(`请先为 ${slotAccelerator(slot)} 导入音乐。`, true);
  const monitorId = $('monitorDevice').value || settings.monitorDeviceId || '';
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
    const devices = allDevices.filter(device => device.kind === 'audiooutput');
    const inputs = allDevices.filter(device => device.kind === 'audioinput');
    const formal = $('outputDevice');
    const monitor = $('monitorDevice');
    const calibration = $('calibrationInput');
    formal.replaceChildren(new Option('系统默认输出', ''));
    monitor.replaceChildren(new Option('系统默认耳机', ''));
    calibration.replaceChildren(new Option('自动选择 Voicemeeter B1', ''));
    for (const device of devices) {
      const label = device.label || '音频输出设备';
      formal.add(new Option(label, device.deviceId));
      monitor.add(new Option(label, device.deviceId));
    }
    for (const device of inputs) {
      const label = device.label || `音频输入设备 ${calibration.options.length}`;
      calibration.add(new Option(label, device.deviceId));
    }
    formal.value = settings?.outputDeviceId || '';
    monitor.value = settings?.monitorDeviceId || '';
    calibration.value = inputs.some(device => device.deviceId === settings?.calibrationInputDeviceId)
      ? settings.calibrationInputDeviceId
      : '';
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
    if (!$('calibrationInput').value) {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach(trackItem => trackItem.stop());
      const refreshed = await refreshDevices();
      const preferred = refreshed.inputs.find(device => /Voicemeeter Out B1|Voicemeeter Output/i.test(device.label));
      if (preferred) $('calibrationInput').value = preferred.deviceId;
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
    const currentMicGainDb = Number(settings.micGainDb ?? 2);
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
      micGainDb: micResult.micGainDb,
      calibrationInputDeviceId: deviceId
    });
    if (!result.ok) throw new Error(result.error || '保存音量失败。');
    settings = result.settings;
    updateVolumeDisplay(settings.musicVolume);
    applyWeakNetworkGraph();
    monitorPlayer.volume = settings.monitorVolume;
    previewPlayer.volume = settings.monitorVolume;
    $('calibrationHint').textContent = `固定结果：麦克风增益 ${Number(settings.micGainDb).toFixed(1)} dB，音乐 ${Math.round(settings.musicVolume * 100)}%；以后启动会一直使用。`;
    show(`校准完成：麦克风 ${Number(settings.micGainDb).toFixed(1)} dB，音乐 ${Math.round(settings.musicVolume * 100)}%。`);
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
  renderLibraryStatus();
  $('musicLibrary').open = !MusicModel.slots(settings.publicTracks).some(Boolean) && !Object.values(settings.mappings || {}).some(value => MusicModel.slots(value).some(Boolean));
  $('weakNetworkMode').checked = Boolean(settings.weakNetworkMode);
  $('loudnessStabilizer').checked = Boolean(settings.loudnessStabilizer);
  applyModeSwitchState();
  updateVolumeDisplay(settings.musicVolume);
  hotkeyDisplays();
  $('calibrationHint').textContent = `固定结果：麦克风增益 ${Number(settings.micGainDb).toFixed(1)} dB，音乐 ${Math.round(settings.musicVolume * 100)}%；以后启动会自动恢复。`;
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

  let outputDeviceId = settings.outputDeviceId || '';
  let monitorDeviceId = settings.monitorDeviceId || '';
  const deviceExists = id => !id || devices.some(device => device.deviceId === id);
  // 监听设备自动回退只在用户已在向导里配置过耳机名时启用。
  let monitorFallbackId = '';
  if (settings.headphoneDeviceName) {
    const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const headphonePattern = new RegExp(escapeRegExp(settings.headphoneDeviceName));
    monitorFallbackId = devices.find(device => headphonePattern.test(device.label) && !/Voicemeeter/i.test(device.label))?.deviceId || '';
  }
  if (!outputDeviceId || !deviceExists(outputDeviceId)) outputDeviceId = devices.find(device => /Voicemeeter Input/i.test(device.label))?.deviceId || '';
  if (!monitorDeviceId || !deviceExists(monitorDeviceId)) monitorDeviceId = monitorFallbackId;
  $('outputDevice').value = outputDeviceId;
  $('monitorDevice').value = monitorDeviceId;
  if (outputDeviceId !== settings.outputDeviceId || monitorDeviceId !== settings.monitorDeviceId) {
    const result = await window.soundboard.saveSettings({ outputDeviceId, monitorDeviceId });
    if (result.ok) settings = result.settings;
  }
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
  window.soundboard.onAudioSetupStatus(status => {
    if (!status.ok) {
      $('outputStatus').textContent = '音频初始化失败，请点击“重新配置音频”。';
      show('音频初始化失败，请重新选择耳机和麦克风。', true);
    }
  });
  // All listeners are wired; ask the main process to replay the current state
  // in case it was broadcast before we could receive it.
  await window.soundboard.rendererReady();
  maybeShowSetupWizard();
}

// —— 初次配置向导 ——
function needsSetup() {
  return !settings.setupDone || !settings.headphoneDeviceName || !settings.microphoneDeviceName;
}

function waitForResult(promise, timeoutMs, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]).finally(() => clearTimeout(timer));
}
let wizardOpening = false;
async function maybeShowSetupWizard(force = false) {
  if ((!force && !needsSetup()) || wizardOpening) return;
  wizardOpening = true;
  $('setupWizard').hidden = false;
  refreshVmStatus();
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
  headphone.replaceChildren(new Option('请选择耳机', ''));
  const outputs = MusicModel.physicalDevices(wizardDeviceLists.outputs);
  outputs.forEach(device => headphone.add(new Option(device.label, device.label)));
  microphone.replaceChildren(new Option('请选择麦克风', ''));
  const inputs = MusicModel.physicalDevices(wizardDeviceLists.inputs);
  inputs.forEach(device => microphone.add(new Option(device.label, device.label)));
  if (settings.headphoneDeviceName) headphone.value = MusicModel.deviceName(settings.headphoneDeviceName);
  if (settings.microphoneDeviceName) microphone.value = MusicModel.deviceName(settings.microphoneDeviceName);
  $('wizardDeviceStatus').textContent = outputs.length && inputs.length ? '设备已就绪，请选择日常使用的物理耳机和麦克风。' : '设备名称不可用，请检查麦克风权限和连接后刷新。';
}

async function refreshVmStatus() {
  const status = await waitForResult(window.soundboard.vmStatus(), 5000, '检测超时').catch(() => ({ installed: false }));
  $('vmStatusText').textContent = status.installed
    ? '已检测到 Voicemeeter，可以继续下一步。'
    : '未检测到 Voicemeeter：点击上方按钮从官网下载安装（免费），完成安装后回到这里。';
  $('vmInstalled').hidden = status.installed;
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
$('vmDownload').onclick = async () => {
  $('vmDownload').disabled = true;
  $('vmDownloadHint').textContent = '正在从 VB-Audio 官网下载（约 15MB）…';
  const result = await window.soundboard.vmInstall().catch(error => ({ ok: false, error: String(error) }));
  $('vmDownload').disabled = false;
  $('vmDownloadHint').textContent = result.ok
    ? '官方安装向导已启动：完成安装后点“我已安装完成，重新检测”。'
    : `下载失败：${result.error || ''}（也可手动访问 vb-audio.com 下载）`;
  if (result.ok) $('vmInstalled').hidden = false;
};
$('vmInstalled').onclick = refreshVmStatus;
$('reconfigureAudio').onclick = () => maybeShowSetupWizard(true);
$('wizardDismiss').onclick = () => { if (!$('wizardFinish').disabled) $('setupWizard').hidden = true; };
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
  $('wizardFinish').disabled = true;
  $('wizardDismiss').disabled = true;
  resultBox.style.color = '';
  resultBox.textContent = '正在写入音频路由（启动 Voicemeeter、设置默认设备、校验增益）…';
  const started = Date.now();
  const progress = setInterval(() => { resultBox.textContent = `正在配置音频路由…已等待 ${Math.floor((Date.now() - started) / 1000)} 秒（最多 80 秒，可失败后重试）。`; }, 1000);
  try {
    const result = await waitForResult(window.soundboard.wizardComplete({ headphoneDeviceName, microphoneDeviceName }), 80000, '音频配置等待超时，请检查设备与 Voicemeeter 后重试。');
    clearInterval(progress);
    if (!result.ok) throw new Error(result.error || '音频配置失败，请重新选择设备。');
    settings = result.settings;
    resultBox.textContent = '配置完成，正在更新播放设备…';
    await waitForResult(refreshDevices(), 8000, '音频路由已配置，但刷新播放设备超时。');
    const virtual = [...$('outputDevice').options].find(item => /Voicemeeter Input/i.test(item.text));
    const headphoneName = MusicModel.deviceName(headphoneDeviceName);
    const monitor = [...$('monitorDevice').options].find(item => item.value && !['default', 'communications'].includes(item.value) && MusicModel.deviceName(item.text) === headphoneName);
    if (!virtual || !monitor) throw new Error('音频路由已配置，但播放设备尚未就绪；请刷新设备后重试。');
    const saved = await window.soundboard.saveSettings({ outputDeviceId: virtual.value, monitorDeviceId: monitor.value });
    if (!saved.ok) throw new Error(saved.error || '保存播放设备失败。');
    settings = saved.settings;
    $('outputDevice').value = virtual.value;
    $('monitorDevice').value = monitor.value;
    if (!await waitForResult(setOutputDevices(), 8000, '绑定播放设备超时。')) throw new Error('绑定播放设备失败，请重试。');
    $('setupWizard').hidden = true;
    show('音频配置完成，已连接虚拟输出与物理耳机。');
  } catch (error) {
    resultBox.style.color = '#b42335';
    resultBox.textContent = `配置失败：${error.message || String(error)}`;
  } finally {
    clearInterval(progress);
    $('wizardFinish').disabled = false;
    $('wizardDismiss').disabled = false;
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
$('calibrationInput').onchange = async () => {
  const result = await window.soundboard.saveSettings({ calibrationInputDeviceId: $('calibrationInput').value });
  if (result.ok) settings = result.settings;
  else show(result.error, true);
};
$('calibrateVolume').onclick = calibrateFixedVolume;
$('outputDevice').onchange = async () => {
  const result = await window.soundboard.saveSettings({ outputDeviceId: $('outputDevice').value });
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
  const result = await window.soundboard.saveSettings({ weakNetworkMode, ...extra });
  if (result.ok) {
    settings = result.settings;
    applyWeakNetworkGraph();
    applyModeSwitchState();
    show(weakNetworkMode
      ? 'QQ 弱网模式已开启：仅优化送入 B1 的音乐，耳机监听保持原音（响度稳定器已停用）。'
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
  const result = await window.soundboard.saveSettings({ loudnessStabilizer, ...extra });
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
$('useVoicemeeter').onclick = async () => {
  const option = [...$('outputDevice').options].find(item => /Voicemeeter Input/i.test(item.text));
  if (!option) return show('未找到 Voicemeeter Input。请先点“刷新设备”，确认 Voicemeeter 已启动。', true);
  $('outputDevice').value = option.value;
  const result = await window.soundboard.saveSettings({ outputDeviceId: option.value });
  if (result.ok) { settings = result.settings; await setOutputDevices(); show('英雄音乐会发送到 Voicemeeter B1，同时由物理耳机监听。'); }
  else show(result.error, true);
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
  if (outputTest) { outputTest.pause(); outputTest.removeAttribute('src'); outputTest.load(); outputTest = null; }
}
async function testOutput(virtual) {
  stopOutputTest();
  if (!player.paused) pauseActive('已暂停音乐，开始输出测试。');
  previewPlayer.pause();
  const id = virtual ? $('outputDevice').value : $('monitorDevice').value;
  if (virtual && (!id || id === 'default')) return show('请先选择 Voicemeeter Input 虚拟输出设备。', true);
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
  if (!player.paused) pauseActive('音频设备发生变化，已暂停。请检查输出设备后继续播放。');
  await refreshDevices();
  await setOutputDevices();
});

init().catch(error => show(`初始化失败：${error.message}`, true));
