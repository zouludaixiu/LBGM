const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const model = require('../renderer/music-model');
function fixture(stored) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lbgm-config-test-'));
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify(stored));
  const handlers = new Map();
  const children=[];
  const childProcess={ ...require('child_process'), spawn(){
    const child=new EventEmitter(); child.exitCode=null; child.pid=children.length+1;
    child.kill=()=>{child.exitCode=0;setTimeout(()=>child.emit('exit'),0);};
    children.push(child); return child;
  } };
  const electron = { app:{ commandLine:{ appendSwitch(){} }, disableHardwareAcceleration(){}, requestSingleInstanceLock(){return true},
    on(){}, whenReady(){ return new Promise(()=>{}); }, getPath(){ return directory; } },
    ipcMain:{ handle(name,fn){handlers.set(name,fn);} },globalShortcut:{register:()=>true,unregisterAll(){} } };
  const context = vm.createContext({ require:name => name==='electron' ? electron : name==='child_process' ? childProcess : name==='./renderer/music-model' ? model : require(name),
    __dirname:path.resolve(__dirname,'..'),process,Buffer,console,setTimeout,clearTimeout,setInterval:()=>0,clearInterval(){} });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../main.js'),'utf8'),context);
  return { directory, handlers, context, children };
}
test('实际主进程迁移备份映射，并继承旧音量与Shift快捷键', async () => {
  const stored = { mappings:{ 暗裔剑魔:{ path:'a.mp3',url:'file:///a.mp3',name:'a' } }, musicVolume:0.27,
    micGainDb:12,playHotkeys:['Shift+1','Shift+2','Shift+3'],pauseHotkey:'Ctrl+A' };
  const f=fixture(stored);
  await vm.runInContext('loadConfig()',f.context);
  const saved=JSON.parse(fs.readFileSync(path.join(f.directory,'settings.json')));
  const backup=JSON.parse(fs.readFileSync(path.join(f.directory,'settings.before-v1.1.json')));
  assert.deepEqual(backup,stored);
  assert.deepEqual(saved.playHotkeys,stored.playHotkeys);
  assert.equal(saved.monitorVolume,0.27);
  assert.equal(saved.mappings['暗裔剑魔'][0].url,'file:///a.mp3');
  assert.deepEqual(saved.publicTracks,[null,null,null]);
});
test('并发保存公共池/最近英雄/音量，文件完整且备份不会覆盖', async () => {
  const f=fixture({mappings:{ 亚索:[{url:'a'}]},musicVolume:0.13});
  await vm.runInContext('loadConfig()',f.context);
  const backup=fs.readFileSync(path.join(f.directory,'settings.before-v1.1.json'),'utf8');
  const save=f.handlers.get('save-settings');
  await Promise.all([save(null,{publicTracks:[{url:'b'},null,null]}),save(null,{recentChampions:['亚索']}),save(null,{monitorVolume:0.4})]);
  const saved=JSON.parse(fs.readFileSync(path.join(f.directory,'settings.json')));
  assert.equal(saved.publicTracks[0].url,'b');
  assert.deepEqual(saved.recentChampions,['亚索']);
  assert.equal(saved.monitorVolume,0.4);
  assert.equal(saved.mappings['亚索'][0].url,'a');
  await vm.runInContext('loadConfig()',f.context);
  assert.equal(fs.readFileSync(path.join(f.directory,'settings.before-v1.1.json'),'utf8'),backup);
});
test('公共池音频可用于校准，未映射文件仍拒绝读取', async () => {
  const f=fixture({mappings:{}});
  const audio=path.join(f.directory,'public.wav');
  fs.writeFileSync(audio,Buffer.from('test'));
  await vm.runInContext('loadConfig()',f.context);
  await f.handlers.get('save-settings')(null,{publicTracks:[{path:audio,url:'file:///test'}]});
  assert.equal((await f.handlers.get('read-mapped-audio')(null,audio)).toString(),'test');
  await assert.rejects(()=>f.handlers.get('read-mapped-audio')(null,path.join(f.directory,'settings.json')));
});
test('向导失败不标记完成、不启动守护，成功后才保存完成状态', async () => {
  const f=fixture({mappings:{亚索:[{url:'a'}]},musicVolume:0.13});
  await vm.runInContext('loadConfig()',f.context);
  vm.runInContext('configureAudioRouting=async()=>({ok:false,error:"设备不存在"}); startAudioRouteWatchdog=()=>{throw new Error("失败不应启动守护")}',f.context);
  const handler=f.handlers.get('wizard-complete');
  const failed=await handler(null,{headphoneDeviceName:'Default - 耳机 (Fixture Audio)',microphoneDeviceName:'Communications - 麦克风 (Fixture Audio)'});
  assert.equal(failed.ok,false);
  assert.equal(failed.settings.setupDone,false);
  assert.equal(failed.settings.headphoneDeviceName,'耳机 (Fixture Audio)');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory,'settings.json'))).setupDone,false);
  vm.runInContext('configureAudioRouting=async()=>({ok:true}); startAudioRouteWatchdog=()=>true',f.context);
  const succeeded=await handler(null,{headphoneDeviceName:'耳机 (Fixture Audio)',microphoneDeviceName:'麦克风 (Fixture Audio)'});
  assert.equal(succeeded.ok,true);
  assert.equal(succeeded.settings.setupDone,true);
  assert.equal(succeeded.settings.mappings['亚索'][0].url,'a');
});
test('主进程接受改键并保存，替换旧快捷键助手不会清除新进程', async () => {
  const f=fixture({ mappings:{}, playHotkeys:['Shift+1','Shift+2','Shift+3'], pauseHotkey:'Ctrl+A' });
  await vm.runInContext('loadConfig()',f.context);
  const save=f.handlers.get('save-settings');
  const first=await save(null,{playHotkeys:['Ctrl+F6','Shift+2','Shift+3']});
  assert.equal(first.ok,true);
  const second=await save(null,{playHotkeys:['Ctrl+F7','Shift+2','Shift+3']});
  assert.equal(second.ok,true);
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(vm.runInContext('hotkeyHelper.pid',f.context),f.children.at(-1).pid);
  const stored=JSON.parse(fs.readFileSync(path.join(f.directory,'settings.json')));
  assert.equal(stored.playHotkeys[0],'Ctrl+F7');
  const duplicate=await save(null,{playHotkeys:['Ctrl+A','Shift+2','Shift+3']});
  assert.equal(duplicate.ok,false);
  const reserved=await save(null,{pauseHotkey:'Ctrl+4'});
  assert.equal(reserved.ok,false);
  assert.match(reserved.error,/Ctrl\+4/);
});

test('Ctrl+4 注册重播事件、去重且改键时不触发', async () => {
  const f=fixture({mappings:{}});
  await vm.runInContext('loadConfig()',f.context);
  vm.runInContext("var restartEvents=[];emit=(name)=>restartEvents.push(name);triggerRestart();triggerRestart()",f.context);
  assert.deepEqual(Array.from(vm.runInContext('restartEvents',f.context)),['restart-playback']);
  vm.runInContext('hotkeyCapture={};lastRestartTriggerAt=0;triggerRestart()',f.context);
  assert.equal(vm.runInContext('restartEvents.length',f.context),1);
});

test('旧 Ctrl+4 自定义键避让固定重播键，其余键和原始备份保留', async () => {
  const f=fixture({mappings:{},playHotkeys:['Ctrl+4','Ctrl+F1','Shift+3'],pauseHotkey:'Ctrl+A'});
  await vm.runInContext('loadConfig()',f.context);
  const saved=JSON.parse(fs.readFileSync(path.join(f.directory,'settings.json')));
  assert.deepEqual(saved.playHotkeys,['Ctrl+F2','Ctrl+F1','Shift+3']);
  assert.equal(saved.pauseHotkey,'Ctrl+A');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory,'settings.before-v1.1.json'))).playHotkeys[0],'Ctrl+4');
});
