const test=require('node:test'),assert=require('node:assert/strict');
const model=require('../renderer/music-model');
const {validate}=require('../renderer/internal-audio');
test('正式混合峰值保护保留低电平原始样本、双声道过载不爆音',()=>{
  const fs=require('fs'),vm=require('vm'),path=require('path');let Guard;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../renderer/peak-guard.js'),'utf8'),{AudioWorkletProcessor:class{},sampleRate:48000,registerProcessor:(_name,value)=>{Guard=value}});
  const guard=new Guard(),input=[new Float32Array([0.1,-0.2,3]),new Float32Array([0.15,-0.1,2])],output=[new Float32Array(3),new Float32Array(3)];
  guard.process([input],[output]);assert.ok(Math.abs(output[0][0]-0.1)<1e-6);assert.ok(Math.abs(output[0][1]+0.2)<1e-6);
  for(const channel of output)for(const value of channel)assert.ok(Math.abs(value)<=0.890001);
});
test('旧库迁移到内部混音保留音量和映射，要求重新配置CABLE',()=>{
  const migrated=model.migrate({musicVolume:0.13,micGainDb:12,weakNetworkMode:true,loudnessStabilizer:false,mappings:{a:[{url:'a'}]}});
  assert.equal(migrated.audioBackend,'internal');assert.equal(migrated.setupDone,false);assert.equal(migrated.internalMicGainDb,0);
  assert.equal(migrated.internalWeakNetworkMode,false);assert.equal(migrated.internalLoudnessStabilizer,false);
  assert.equal(migrated.weakNetworkMode,true);assert.equal(migrated.micGainDb,12);assert.equal(migrated.musicVolume,0.13);
});
test('正式内部混音严格拒绝默认、虚拟麦克风、耳机输出误路由',()=>{
  const good={mic:{deviceId:'mic',label:'Mic'},cable:{deviceId:'cable',label:'CABLE Input (VB-Audio Virtual Cable)'},monitor:{deviceId:'ears',label:'Headphones'}};
  assert.doesNotThrow(()=>validate(good));
  for(const [key,label] of [['mic','CABLE Output'],['mic','Voicemeeter Out B1'],['monitor','CABLE Input'],['cable','Headphones']])assert.throws(()=>validate({...good,[key]:{deviceId:'test',label}}));
  for(const key of ['mic','cable','monitor'])assert.throws(()=>validate({...good,[key]:{...good[key],deviceId:'default'}}));
  assert.equal(model.physicalDevices([{deviceId:'c',label:'CABLE Output'},{deviceId:'vm',label:'Voicemeeter'},{deviceId:'mic',label:'USB Mic'}]).length,1);
});
