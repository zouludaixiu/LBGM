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

test('真实MediaDeviceInfo原型getter保留设备ID，向导不会误判真实麦克风为默认项', () => {
  // Browser MediaDeviceInfo objects cannot be faithfully represented by a
  // plain object with enumerable deviceId/label fields.
  const make = (id,label) => Object.create(Object.defineProperties({}, {
    deviceId:{get:()=>id},label:{get:()=>label},kind:{get:()=> 'audioinput'},groupId:{get:()=> 'physical-usb'}
  }));
  const mic=make('physical-usb','麦克风 (Fixture USB Audio)');
  assert.deepEqual({...mic},{});
  const devices=model.physicalDevices([make('default','Default - 麦克风 (Fixture USB Audio)'),mic,make('communications','Communications - 麦克风 (Fixture USB Audio)')]);
  assert.equal(devices.length,1);assert.equal(devices[0].deviceId,'physical-usb');
  assert.equal(devices[0].kind,'audioinput');assert.equal(devices[0].groupId,'physical-usb');
  const {validate}=require('../renderer/internal-audio');
  assert.doesNotThrow(()=>validate({mic:devices[0],monitor:{deviceId:'ears',label:'耳机 (Fixture USB Audio)'},cable:{deviceId:'cable',label:'CABLE Input'}}));
});

test('设备恢复优先精确ID，ID变化时仅恢复唯一同名设备', () => {
  const first={deviceId:'other',label:'CABLE Input'},chosen={deviceId:'saved',label:'CABLE Input'};
  assert.equal(model.matchDevice([first,chosen],'saved','CABLE Input'),chosen);
  assert.equal(model.matchDevice([chosen],'old-id','CABLE Input'),chosen);
  assert.equal(model.matchDevice([first,chosen],'old-id','CABLE Input'),null);
  assert.equal(model.matchDevice([{deviceId:'default',label:'CABLE Input'}],'default','CABLE Input'),null);
  assert.equal(model.matchDevice([{deviceId:'new',label:'Default - USB Mic'}],'old-id','USB Mic').deviceId,'new');
});
