const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),path=require('path');
const {validateDevices,range}=require('../prototype/audio-mixer/engine');
const valid={mic:{deviceId:'mic',label:'USB Microphone'},cable:{deviceId:'cable',label:'CABLE Input (VB-Audio Virtual Cable)'},monitor:{deviceId:'headset',label:'USB Headphones'}};
test('原型设备选择拒绝虚拟麦克风、默认输出与反馈路由',()=>{
  assert.doesNotThrow(()=>validateDevices(valid));
  assert.throws(()=>validateDevices({...valid,mic:{deviceId:'b1',label:'Voicemeeter Out B1'}}));
  assert.throws(()=>validateDevices({...valid,cable:{deviceId:'headset',label:'USB Headphones'}}));
  assert.throws(()=>validateDevices({...valid,cable:{deviceId:'default',label:'CABLE Input'}}));
  assert.throws(()=>validateDevices({...valid,monitor:{deviceId:'cable',label:'CABLE Output'}}));
});
test('原型片段合法性与结束留空',()=>{
  assert.deepEqual(range({startTime:0.2,endTime:null},3),{start:0.2,end:3});
  assert.throws(()=>range({startTime:3,endTime:null},3));
  assert.throws(()=>range({startTime:0,endTime:4},3));
  assert.throws(()=>range({startTime:1,endTime:0.5},3));
});
test('实时峰值保护保留安静信号，双声道过载不超过0.89',()=>{
  let Guard;vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../prototype/audio-mixer/limiter-worklet.js'),'utf8'),{AudioWorkletProcessor:class{},sampleRate:48000,registerProcessor:(_name,processor)=>{Guard=processor}});
  const guard=new Guard(),input=[new Float32Array([0.1,2,-3,0.1]),new Float32Array([0.2,1,-1,0.1])],output=[new Float32Array(4),new Float32Array(4)];
  assert.equal(guard.process([input],[output]),true);
  assert.ok(Math.abs(output[0][0]-0.1)<1e-6);
  for(const channel of output)for(const value of channel)assert.ok(Math.abs(value)<=0.890001);
  assert.ok(Math.abs(output[0][2]/output[1][2]-3)<1e-5);
});
