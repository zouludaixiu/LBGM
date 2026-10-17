// Independent experiment: never imports LBGM main.js or writes its settings.
const {app,BrowserWindow,ipcMain,dialog,shell}=require('electron');
const fs=require('fs'),path=require('path');
const {pathToFileURL}=require('url');
app.setName('LBGM Audio Prototype');
app.setPath('userData',path.join(app.getPath('appData'),'lbgm-audio-prototype'));
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
app.disableHardwareAcceleration();
let win;
const configPath=()=>path.join(app.getPath('userData'),'prototype-settings.json');
function load(){try{return JSON.parse(fs.readFileSync(configPath(),'utf8'))}catch{return {}}}
let settings=load(),saveQueue=Promise.resolve();
ipcMain.handle('prototype-settings',()=>settings);
ipcMain.handle('prototype-save',(_event,changes)=>{
  const allowed=['micId','cableId','monitorId','micLabel','cableLabel','monitorLabel','micGainDb','musicVolume','monitorVolume','tracks'];
  for(const key of allowed)if(Object.hasOwn(changes,key))settings[key]=changes[key];
  const snapshot=JSON.stringify(settings,null,2);
  saveQueue=saveQueue.catch(()=>{}).then(async()=>{await fs.promises.mkdir(path.dirname(configPath()),{recursive:true});await fs.promises.writeFile(configPath()+'.tmp',snapshot);await fs.promises.rename(configPath()+'.tmp',configPath())});
  return saveQueue.then(()=>({ok:true}));
});
ipcMain.handle('prototype-audio',async()=>{
  const result=await dialog.showOpenDialog(win,{title:'导入原型测试 BGM',properties:['openFile'],filters:[{name:'音频',extensions:['mp3','wav','ogg','m4a','flac']}]});
  if(result.canceled)return null;
  const file=result.filePaths[0];return {name:path.basename(file),url:pathToFileURL(file).href,startTime:0,endTime:null};
});
ipcMain.handle('prototype-cable-help',()=>shell.openExternal('https://vb-audio.com/Cable/'));
if(!app.requestSingleInstanceLock())app.quit();
else app.whenReady().then(()=>{
  win=new BrowserWindow({width:1030,height:900,minWidth:740,minHeight:660,title:'LBGM 内部混音 · 第一阶段原型',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  const ownUrl=pathToFileURL(path.join(__dirname,'index.html')).href;
  win.webContents.session.setPermissionRequestHandler((wc,permission,callback)=>callback(wc===win.webContents && wc.getURL()===ownUrl && ['media','speaker-selection'].includes(permission)));
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event,url)=>{if(url!==ownUrl)event.preventDefault()});
  win.on('close',event=>{
    if(!win?.webContents.isDestroyed()){
      const choice=dialog.showMessageBoxSync(win,{type:'warning',title:'退出混音原型',message:'退出后，CABLE Output 将不再收到本原型的麦克风声音。',detail:'若 QQ 正在使用 CABLE Output，请切回真实麦克风或原有 Voicemeeter B1。最小化窗口可以继续传输。',buttons:['继续运行','退出原型'],defaultId:0,cancelId:0});
      if(choice===0)event.preventDefault();
    }
  });
  win.loadFile(path.join(__dirname,'index.html'));
});
app.on('second-instance',()=>{if(win){win.restore();win.show();win.focus()}});
app.on('window-all-closed',()=>app.quit());
