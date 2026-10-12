(function (root, factory) {
  const model = factory();
  if (typeof module === 'object' && module.exports) module.exports = model;
  else root.MusicModel = model;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function slots(value) {
    const list = Array.isArray(value) ? value : value ? [value] : [];
    return [list[0] || null, list[1] || null, list[2] || null];
  }
  function resolve(settings, champion, slot) {
    const own = settings.playbackMode === 'public' ? null : slots(settings.mappings?.[champion])[slot];
    return own ? { track: own, source: 'champion', key: champion } :
      { track: slots(settings.publicTracks)[slot], source: 'public', key: '公共音乐池' };
  }
  function range(track, duration = Infinity) {
    const start = Number.isFinite(track?.startTime) ? Math.max(0, track.startTime) : 0;
    const end = Number.isFinite(track?.endTime) ? Math.min(track.endTime, duration) : duration;
    if (start >= end) throw new Error('片段结束时间必须晚于开始时间，且开始时间不能超过音频长度。');
    return { start, end };
  }
  function migrate(settings) {
    const result = { ...settings, publicTracks: slots(settings.publicTracks) };
    result.monitorVolume = Number.isFinite(settings.monitorVolume) ? settings.monitorVolume : (settings.musicVolume ?? 0.13);
    result.recentChampions = [...new Set((settings.recentChampions || []).filter(name => typeof name === 'string' && name))].slice(0, 8);
    result.playbackMode = settings.playbackMode === 'public' ? 'public' : 'auto';
    return result;
  }
  function recent(list, name) { return [name, ...list.filter(item => item !== name)].slice(0, 8); }
  function deviceName(label) { return String(label || '').replace(/^(?:(?:Default|Communications|默认|通信)\s*[-–—:：]\s*)+/i, '').trim(); }
  function physicalDevices(devices) {
    const result = new Map();
    for (const device of devices) {
      const name = deviceName(device.label);
      if (!name || /voicemeeter/i.test(name)) continue;
      if (!result.has(name) || !['default', 'communications'].includes(device.deviceId)) result.set(name, { ...device, label: name });
    }
    return [...result.values()];
  }
  function same(a, b) { return Boolean(a && b && a.url === b.url && (a.startTime || 0) === (b.startTime || 0) && (a.endTime ?? null) === (b.endTime ?? null)); }
  return { slots, resolve, range, migrate, recent, same, deviceName, physicalDevices };
});
