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

function slotAccelerator(slot) { return settings?.playHotkeys?.[slot] || DEFAULT_PLAY_HOTKEYS[slot]; }
function pauseAcceleratorText() { return settings?.pauseHotkey || 'Ctrl+A'; }

function hotkeyDisplays() {
  for (let slot = 0; slot < 3; slot++) {
    $(`slotKey${slot + 1}`).textContent = slotAccelerator(slot);
    $(`hotkey${slot}`).value = slotAccelerator(slot);
  }
  $('hotkeyPause').value = pauseAcceleratorText();
  $('playbackHelp').textContent = `播放中再按相同播放键（当前 ${slotAccelerator(0)} / ${slotAccelerator(1)} / ${slotAccelerator(2)}）或 ${pauseAcceleratorText()}，都会暂停并从原进度继续。`;
}

function captureLabel(target) { return target === 'pause' ? '暂停/继续' : `播放键 ${Number(target) + 1}`; }

async function startHotkeyCapture(target) {
  if (captureTarget) return show('正在修改快捷键；请先确认或取消。', true);
  const result = await window.soundboard.beginHotkeyCapture();
  if (!result?.ok) return show('无法进入快捷键修改模式。', true);
  captureTarget = target;
  capturedHotkey = '';
  $('captureBar').hidden = false;
  $('captureConfirm').disabled = true;
  $('captureHint').textContent = `正在修改「${captureLabel(target)}」：请按下新的快捷键（Ctrl 或 Shift + 字母/数字/F1~F24），按 Esc 取消。`;
  show(`正在修改「${captureLabel(target)}」的快捷键；改键期间播放快捷键临时失效。`);
}

function acceleratorFromEvent(event) {
  if (event.key === 'Escape') return { cancel: true };
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
  if (!captureTarget) return;
  event.preventDefault();
  event.stopPropagation();
  const parsed = acceleratorFromEvent(event);
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
  if (!captureTarget) return;
  await window.soundboard.cancelHotkeyCapture();
  endHotkeyCaptureUi();
}

async function confirmHotkeyCapture() {
  if (!captureTarget || !capturedHotkey) return;
  const target = captureTarget;
  const nextPlay = (settings.playHotkeys || [...DEFAULT_PLAY_HOTKEYS]).slice();
  let nextPause = settings.pauseHotkey || 'Ctrl+A';
  if (target === 'pause') nextPause = capturedHotkey;
  else nextPlay[Number(target)] = capturedHotkey;
  const combined = [...nextPlay, nextPause].map(value => String(value).toUpperCase());
  if (combined.some(value => !HOTKEY_PATTERN.test(value)) || new Set(combined).size !== combined.length) {
    $('captureHint').textContent = '该快捷键无效或与其他键位重复，请换一个组合。';
    capturedHotkey = '';
    $('captureConfirm').disabled = true;
    return;
  }
  const changes = target === 'pause' ? { pauseHotkey: capturedHotkey } : { playHotkeys: nextPlay };
  const result = await window.soundboard.saveSettings(changes);
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
  $('notice').style.color = error ? '#ffb7bd' : '#a9caff';
}

function updateVolumeDisplay(value = settings?.musicVolume ?? 0.4) {
  const percent = Math.round(Math.max(0.1, Math.min(0.7, Number(value) || 0.4)) * 100);
  $('musicVolume').value = String(percent);
  $('musicVolumeValue').textContent = `${percent}%`;
  $('volumeSummary').textContent = `${percent}%`;
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)))];
}

function championKey() { return $('championInput').value.trim(); }

// Hotkey playback priority: manual override > auto-detected > mapping editor.
function playbackChampionKey() { return settings.manualChampion || currentChampion?.name || championKey(); }

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
  if (visible.includes(current)) select.value = current;
  else if (visible.length === 1) select.value = visible[0];
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
  selectedTracks = tracksFor(key);
  selectedTracks.forEach((track, slot) => {
    $(`trackLabel${slot + 1}`).value = track?.name || '';
    $(`trackLabel${slot + 1}`).placeholder = `未设置第 ${slot + 1} 条音乐`;
  });
  if (!key) {
    $('mappingInfo').textContent = '请选择英雄，或使用自动检测到的英雄。';
    return;
  }
  const summary = selectedTracks.map((track, slot) => `${slotAccelerator(slot)}：${track?.name || '未设置'}`).join('；');
  $('mappingInfo').textContent = `“${key}” — ${summary}`;
}

async function setSink(audio, deviceId, errorMessage) {
  if (typeof audio.setSinkId !== 'function') return true;
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
  const formalOk = await setSink(graphReady ? qqOutputPlayer : player, formalId, '无法连接“发送到 QQ”的输出设备。');
  const monitorOk = await setSink(monitorPlayer, monitorId, '无法连接耳机监听输出设备。');
  await setSink(previewPlayer, monitorId, '无法连接耳机试听输出设备。');
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
}

async function startActive(resume = false) {
  if (!activeTrack?.url) return false;
  await setOutputDevices();
  applyWeakNetworkGraph();
  player.volume = qqAudioGraph ? 1 : (settings.musicVolume ?? 0.4);
  monitorPlayer.volume = settings.musicVolume ?? 0.4;
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
  show(`${prefix}：${activeTrack.name}（${slotAccelerator(activeSlot)}，音量 ${Math.round((settings.musicVolume ?? 0.4) * 100)}%${weakText}）${monitorOk ? '；QQ 与耳机同步输出。' : '；QQ 正常，但耳机监听启动失败。'}`, !monitorOk);
  return true;
}

async function playSlot(key, slot) {
  const track = tracksFor(key)[slot];
  if (!key) return show('尚未检测或选择英雄。', true);
  if (!track?.url) return show(`“${key}”尚未设置 ${slotAccelerator(slot)} 对应的音乐。`, true);

  const resolvedUrl = new URL(track.url, window.location.href).href;
  const sameTrack = activeKey === key && activeSlot === slot && player.src === resolvedUrl;
  if (sameTrack && !player.paused) {
    pauseActive(`已暂停：${track.name}。再次按 ${slotAccelerator(slot)} 或 ${pauseAcceleratorText()} 将从当前位置继续。`);
    return;
  }
  if (!sameTrack || player.ended) {
    player.pause();
    qqOutputPlayer.pause();
    monitorPlayer.pause();
    player.src = track.url;
    monitorPlayer.src = track.url;
    activeKey = key;
    activeSlot = slot;
    activeTrack = track;
  }
  await startActive(sameTrack && !player.ended);
}

async function togglePausePlayback() {
  if (!activeTrack || !player.src) return show('当前没有正在播放或暂停的音乐。', true);
  if (!player.paused) {
    pauseActive(`已暂停：${activeTrack.name}。再次按 ${pauseAcceleratorText()} 或 ${slotAccelerator(activeSlot)} 将从当前位置继续。`);
    return;
  }
  await startActive(true);
}

async function previewTrack(slot) {
  const track = selectedTracks[slot];
  if (!track?.url) return show(`请先为 ${slotAccelerator(slot)} 导入音乐。`, true);
  const monitorId = $('monitorDevice').value || settings.monitorDeviceId || '';
  if (!await setSink(previewPlayer, monitorId, '无法连接耳机试听输出设备。')) return;
  const resolvedUrl = new URL(track.url, window.location.href).href;
  if (previewPlayer.src === resolvedUrl && !previewPlayer.paused) {
    previewPlayer.pause();
    return show(`已暂停试听：${track.name}。`);
  }
  if (previewPlayer.src !== resolvedUrl || previewPlayer.ended) previewPlayer.src = track.url;
  previewPlayer.volume = settings.musicVolume ?? 0.4;
  try {
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
  if (!track?.path) throw new Error('请先为所选英雄保存至少一条音乐映射。');
  const encoded = await window.soundboard.readMappedAudio(track.path);
  const bytes = encoded instanceof Uint8Array ? encoded : new Uint8Array(encoded);
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const context = new AudioContextClass();
  try {
    const buffer = await context.decodeAudioData(data);
    const blockSize = 2048;
    const totalBlocks = Math.max(1, Math.floor(buffer.length / blockSize));
    const blockStep = Math.max(1, Math.floor(totalBlocks / 2400));
    const levels = [];
    for (let block = 0; block < totalBlocks; block += blockStep) {
      const start = block * blockSize;
      const end = Math.min(buffer.length, start + blockSize);
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
  const track = tracksFor(key).find(Boolean);
  if (!track) return show('请先选择一个已保存音乐映射的英雄，再进行校准。', true);
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
    monitorPlayer.volume = settings.musicVolume;
    previewPlayer.volume = settings.musicVolume;
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
  settings = await window.soundboard.getSettings();
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
  window.soundboard.onPause(() => togglePausePlayback());
  window.soundboard.onChampion(champion => {
    currentChampion = champion;
    ensureChampionOption(champion.name);
    $('currentChampion').textContent = champion.name;
    $('championHint').textContent = champion.locked
      ? `已锁定；${slotAccelerator(0)} / ${slotAccelerator(1)} / ${slotAccelerator(2)} 会播放对应音乐。`
      : '英雄预选中；锁定后也会自动更新。';
    applyManualView();
  });
  window.soundboard.onLcuStatus(status => {
    $('lcuBadge').textContent = status.text;
    $('lcuBadge').classList.toggle('muted', !status.connected);
  });
  // All listeners are wired; ask the main process to replay the current state
  // in case it was broadcast before we could receive it.
  await window.soundboard.rendererReady();
  maybeShowSetupWizard();
}

// —— 初次配置向导 ——
function needsSetup() {
  return !settings.setupDone && (!settings.headphoneDeviceName || !settings.microphoneDeviceName);
}

async function maybeShowSetupWizard() {
  if (!needsSetup()) return;
  $('setupWizard').hidden = false;
  // 先拿一次麦克风权限，设备枚举才会返回可读名称
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    probe.getTracks().forEach(track => track.stop());
  } catch { /* 用户拒绝时仍列出设备，但名称可能不可读 */ }
  wizardDeviceLists = await refreshDevices();
  fillWizardDeviceOptions();
  refreshVmStatus();
}

let wizardDeviceLists = { outputs: [], inputs: [] };

function fillWizardDeviceOptions() {
  const headphone = $('wizardHeadphone');
  const microphone = $('wizardMicrophone');
  headphone.replaceChildren(new Option('请选择耳机', ''));
  wizardDeviceLists.outputs.forEach(device => { if (device.label) headphone.add(new Option(device.label, device.label)); });
  microphone.replaceChildren(new Option('请选择麦克风', ''));
  wizardDeviceLists.inputs.forEach(device => { if (device.label) microphone.add(new Option(device.label, device.label)); });
  if (settings.headphoneDeviceName) headphone.value = settings.headphoneDeviceName;
  if (settings.microphoneDeviceName) microphone.value = settings.microphoneDeviceName;
}

async function refreshVmStatus() {
  const status = await window.soundboard.vmStatus().catch(() => ({ installed: false }));
  $('vmStatusText').textContent = status.installed
    ? '已检测到 Voicemeeter，可以继续下一步。'
    : '未检测到 Voicemeeter：点击上方按钮从官网下载安装（免费），完成安装后回到这里。';
  $('vmInstalled').hidden = status.installed;
}

player.addEventListener('ended', () => {
  qqOutputPlayer.pause();
  monitorPlayer.pause();
  try { monitorPlayer.currentTime = player.duration || 0; } catch { /* media not ready */ }
});

setInterval(() => {
  if (player.paused || monitorPlayer.paused) return;
  if (Math.abs(player.currentTime - monitorPlayer.currentTime) > 0.12) {
    try { monitorPlayer.currentTime = player.currentTime; } catch { /* media not ready */ }
  }
}, 500);

$('useDetected').onclick = () => {
  if (!currentChampion) return show('尚未检测到英雄。', true);
  ensureChampionOption(currentChampion.name);
  $('championInput').value = currentChampion.name;
  applyMappingView();
};
$('manualChampion').onchange = () => setManualChampion($('manualChampion').value);
$('clearManualChampion').onclick = () => setManualChampion('');

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
$('wizardFinish').onclick = async () => {
  const resultBox = $('wizardResult');
  const headphoneDeviceName = $('wizardHeadphone').value;
  const microphoneDeviceName = $('wizardMicrophone').value;
  if (!headphoneDeviceName || !microphoneDeviceName) {
    resultBox.style.color = '#ffb7bd';
    resultBox.textContent = '请先在②中选择耳机和麦克风。';
    return;
  }
  $('wizardFinish').disabled = true;
  resultBox.style.color = '';
  resultBox.textContent = '正在写入音频路由（启动 Voicemeeter、设置默认设备、校验增益）…';
  const result = await window.soundboard.wizardComplete({ headphoneDeviceName, microphoneDeviceName }).catch(error => ({ ok: false, error: String(error) }));
  if (result.ok) {
    settings = result.settings;
    resultBox.textContent = '配置完成！进入主界面。今后请始终从桌面快捷方式（管理员）启动本应用。';
    await refreshDevices();
    await setOutputDevices();
    setTimeout(() => { $('setupWizard').hidden = true; }, 1500);
  } else {
    resultBox.style.color = '#ffb7bd';
    resultBox.textContent = `配置失败：${result.error || ''}（请确认 Voicemeeter 已安装完成后再试）`;
    $('wizardFinish').disabled = false;
  }
};
$('refreshChampions').onclick = refreshChampions;
$('championSearch').oninput = () => renderChampionOptions($('championSearch').value);
$('manualChampionSearch').oninput = () => renderManualOptions($('manualChampionSearch').value);
$('championInput').onchange = applyMappingView;

for (let slot = 0; slot < 3; slot++) {
  $(`chooseTrack${slot + 1}`).onclick = async () => {
    const track = await window.soundboard.chooseAudio();
    if (track) {
      selectedTracks[slot] = track;
      $(`trackLabel${slot + 1}`).value = track.name;
      show(`已选择 ${slotAccelerator(slot)} 音乐；点击“保存三条映射”后生效。`);
    }
  };
  $(`playPreview${slot + 1}`).onclick = () => previewTrack(slot);
  $(`clearTrack${slot + 1}`).onclick = () => {
    selectedTracks[slot] = null;
    $(`trackLabel${slot + 1}`).value = '';
    show(`已清空 ${slotAccelerator(slot)}；点击“保存三条映射”后生效。`);
  };
}

for (let slot = 0; slot < 3; slot++) $(`editHotkey${slot}`).onclick = () => startHotkeyCapture(slot);
$('editHotkeyPause').onclick = () => startHotkeyCapture('pause');
$('captureConfirm').onclick = confirmHotkeyCapture;
$('captureCancel').onclick = cancelHotkeyCapture;

$('saveMapping').onclick = async () => {
  const key = championKey();
  if (!key) return show('请先选择英雄。', true);
  const mappings = { ...settings.mappings };
  if (selectedTracks.some(Boolean)) mappings[key] = [selectedTracks[0] || null, selectedTracks[1] || null, selectedTracks[2] || null];
  else delete mappings[key];
  const result = await window.soundboard.saveSettings({ mappings });
  if (result.ok) {
    settings = result.settings;
    applyMappingView();
    show('三条音乐映射已保存。');
  } else show(result.error, true);
};

$('removeMapping').onclick = async () => {
  const key = championKey();
  if (!key) return;
  const mappings = { ...settings.mappings };
  delete mappings[key];
  const result = await window.soundboard.saveSettings({ mappings });
  if (result.ok) {
    settings = result.settings;
    applyMappingView();
    show('该英雄的全部音乐映射已移除。');
  } else show(result.error, true);
};

$('refreshDevices').onclick = async () => { await refreshDevices(); await setOutputDevices(); };
$('musicVolume').oninput = () => {
  const musicVolume = Number($('musicVolume').value) / 100;
  settings.musicVolume = musicVolume;
  updateVolumeDisplay(musicVolume);
  applyWeakNetworkGraph();
  monitorPlayer.volume = musicVolume;
  previewPlayer.volume = musicVolume;
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

init();
