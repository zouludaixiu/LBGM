const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const model = require('../renderer/music-model');
function fixture(stored, preview = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lbgm-config-test-'));
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify(stored));
  let userDirectory=directory;
  if(preview){fs.mkdirSync(path.join(directory,'champion-soundboard'));fs.writeFileSync(path.join(directory,'champion-soundboard/settings.json'),JSON.stringify(stored));}
  const handlers = new Map();
  const children=[];
  const childProcess={ ...require('child_process'), spawn(){
    const child=new EventEmitter(); child.exitCode=null; child.pid=children.length+1;
    child.kill=()=>{child.exitCode=0;setTimeout(()=>child.emit('exit'),0);};
    children.push(child); return child;
  } };
  const electron = { app:{ commandLine:{ appendSwitch(){} }, disableHardwareAcceleration(){}, requestSingleInstanceLock(){return true},
    on(){}, whenReady(){ return new Promise(()=>{}); }, getPath(name){ return name==='appData'?directory:userDirectory; },setName(){},setPath(name,value){if(name==='userData')userDirectory=value;} },
    ipcMain:{ handle(name,fn){handlers.set(name,fn);} },globalShortcut:{register:()=>true,unregisterAll(){} } };
  const context = vm.createContext({ require:name => name==='electron' ? electron : name==='child_process' ? childProcess : name==='./renderer/music-model' ? model : require(name),
    __dirname:path.resolve(__dirname,'..'),process:preview?{...process,argv:[...process.argv,'--audio-preview']}:process,Buffer,console,setTimeout,clearTimeout,setInterval:()=>0,clearInterval(){} });
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
test('向导拒绝缺失设备，明确选择CABLE后仅保存待连接状态', async () => {
  const f=fixture({mappings:{亚索:[{url:'a'}]},musicVolume:0.13,setupDone:true});
  await vm.runInContext('loadConfig()',f.context);
  const handler=f.handlers.get('wizard-complete');
  assert.equal((await handler(null,{headphoneDeviceName:'耳机',microphoneDeviceName:'麦克风'})).ok,false);
  const succeeded=await handler(null,{headphoneDeviceName:'Default - 耳机',microphoneDeviceName:'Communications - 麦克风',internalMicDeviceId:'mic',monitorDeviceId:'ears',cableOutputDeviceId:'cable',cableOutputDeviceName:'CABLE Input'});
  assert.equal(succeeded.ok,true);
  assert.equal(succeeded.settings.setupDone,false);
  assert.equal(succeeded.settings.headphoneDeviceName,'耳机');
  assert.equal(succeeded.settings.internalMicDeviceName,'麦克风');
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

test('内部混音配置不运行Voicemeeter、不改旧映射/输出/校准值，连接后才完成向导', async () => {
  const f=fixture({mappings:{亚索:[{url:'old'}]},outputDeviceId:'vm-id',musicVolume:0.13,micGainDb:12,weakNetworkMode:true,setupDone:true});
  await vm.runInContext('loadConfig()',f.context);
  const handler=f.handlers.get('wizard-complete');
  const invalid=await handler(null,{audioBackend:'internal',headphoneDeviceName:'耳机',microphoneDeviceName:'麦克风',internalMicDeviceId:'default',monitorDeviceId:'ears',cableOutputDeviceId:'cable',cableOutputDeviceName:'CABLE Input'});
  assert.equal(invalid.ok,false);
  const configured=await handler(null,{audioBackend:'internal',headphoneDeviceName:'耳机',microphoneDeviceName:'麦克风',internalMicDeviceId:'mic',monitorDeviceId:'ears',cableOutputDeviceId:'cable',cableOutputDeviceName:'CABLE Input'});
  assert.equal(configured.ok,true);assert.equal(configured.defaultsUnchanged,true);
  assert.equal(configured.settings.setupDone,false);
  assert.equal(configured.settings.outputDeviceId,'vm-id');
  assert.equal(configured.settings.micGainDb,12);assert.equal(configured.settings.internalMicGainDb,0);
  assert.equal(configured.settings.musicVolume,0.13);assert.equal(configured.settings.weakNetworkMode,true);assert.equal(configured.settings.internalWeakNetworkMode,false);
  assert.equal(configured.settings.mappings['亚索'][0].url,'old');
  const gain=await f.handlers.get('apply-mic-gain')(null,6);
  assert.equal(gain.ok,true);assert.equal(gain.micGainDb,6);
  const saved=JSON.parse(fs.readFileSync(path.join(f.directory,'settings.json')));
  assert.equal(saved.micGainDb,12);assert.equal(saved.internalMicGainDb,6);
});

test('已删除旧路由、守护和安装IPC，拒绝恢复Voicemeeter方案', async () => {
  const f=fixture({audioBackend:'internal',mappings:{},setupDone:true});
  await vm.runInContext('loadConfig()',f.context);
  assert.equal(vm.runInContext('typeof configureAudioRouting',f.context),'undefined');
  assert.equal(vm.runInContext('typeof startAudioRouteWatchdog',f.context),'undefined');
  assert.equal(f.handlers.has('wizard-vm-status'),false);
  assert.equal(f.handlers.has('wizard-vm-install'),false);
  assert.equal((await f.handlers.get('save-settings')(null,{audioBackend:'voicemeeter'})).ok,false);
  assert.equal((await f.handlers.get('wizard-complete')(null,{audioBackend:'voicemeeter'})).ok,false);
});

test('整合测试版首次复制映射，配置隔离且再次启动不覆盖测试库', async () => {
  const stored={mappings:{亚索:[{url:'old'}]},musicVolume:0.13,micGainDb:12,playHotkeys:['Shift+1','Shift+2','Shift+3'],microphoneDeviceName:'USB Mic',setupDone:true};
  const f=fixture(stored,true);await vm.runInContext('loadConfig()',f.context);
  const visible=await f.handlers.get('get-settings')();assert.equal(visible.audioPreview,true);assert.equal(visible.previewBuild,'2026.10.17');
  const previewPath=path.join(f.directory,'lbgm-internal-preview/settings.json');
  const copy=JSON.parse(fs.readFileSync(previewPath));
  assert.equal(copy.audioBackend,'internal');assert.equal(copy.setupDone,false);assert.equal(copy.internalMicGainDb,0);
  assert.deepEqual(copy.mappings['亚索'],[stored.mappings['亚索'][0],null,null]);assert.equal(copy.musicVolume,0.13);assert.equal(copy.micGainDb,12);
  await f.handlers.get('save-settings')(null,{publicTracks:[{url:'new'}],internalMicGainDb:3});
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory,'champion-soundboard/settings.json'))),stored);
  await vm.runInContext('loadConfig()',f.context);
  assert.equal(JSON.parse(fs.readFileSync(previewPath)).publicTracks[0].url,'new');
});
