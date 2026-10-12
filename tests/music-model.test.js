const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../renderer/music-model');

test('旧映射与音量迁移不丢失，自定义快捷键保持原样', () => {
  const track = { url: 'file:///a.mp3', name: 'a' };
  const original = { mappings: { 剑魔: [track, null, null] }, musicVolume: 0.13, playHotkeys: ['Shift+1','Shift+2','Shift+3'] };
  const migrated = model.migrate(original);
  assert.deepEqual(migrated.mappings, original.mappings);
  assert.deepEqual(migrated.playHotkeys, original.playHotkeys);
  assert.equal(migrated.monitorVolume, 0.13);
  assert.deepEqual(migrated.publicTracks, [null, null, null]);
});
test('英雄专属按槽位优先，空槽和无英雄回退公共池', () => {
  const own = { url: 'own' }, common = { url: 'common' };
  const config = { mappings: { 剑魔: [own] }, publicTracks: [common, common, null] };
  assert.equal(model.resolve(config, '剑魔', 0).track, own);
  assert.equal(model.resolve(config, '剑魔', 1).track, common);
  assert.equal(model.resolve(config, '', 0).source, 'public');
  assert.equal(model.resolve(config, '未知英雄', 0).track, common);
  assert.equal(model.resolve({ ...config, playbackMode: 'public' }, '剑魔', 0).track, common);
});
test('最近英雄去重、保持顺序且最多8个', () => {
  assert.deepEqual(model.recent(['a','b'], 'b'), ['b','a']);
  assert.equal(model.recent(['a','b','c','d','e','f','g','h'], 'i').length, 8);
});
test('旧音频默认整首，片段边界校验且不超出文件长度', () => {
  assert.deepEqual(model.range({}, 90), { start: 0, end: 90 });
  assert.deepEqual(model.range({ startTime: 10, endTime: 100 }, 90), { start: 10, end: 90 });
  assert.throws(() => model.range({ startTime: 20, endTime: 10 }, 90));
  assert.throws(() => model.range({ startTime: 100 }, 90));
  assert.equal(model.same({ url:'a', startTime:0 }, { url:'a' }), true);
  assert.equal(model.same({ url:'a', startTime:10 }, { url:'a' }), false);
});
test('音频设备别名标准化，默认/通信项去重且排除Voicemeeter', () => {
  assert.equal(model.deviceName('Default - 耳机 (Fixture Audio)'), '耳机 (Fixture Audio)');
  assert.equal(model.deviceName('Communications - 麦克风 (Fixture Audio)'), '麦克风 (Fixture Audio)');
  assert.equal(model.deviceName('默认 - 耳机 (Fixture Audio)'), '耳机 (Fixture Audio)');
  const result=model.physicalDevices([{deviceId:'default',label:'Default - 耳机 (Fixture Audio)'}, {deviceId:'real',label:'耳机 (Fixture Audio)'}, {deviceId:'vm',label:'Voicemeeter Input'}]);
  assert.equal(result.length,1);
  assert.equal(result[0].deviceId,'real');
});
