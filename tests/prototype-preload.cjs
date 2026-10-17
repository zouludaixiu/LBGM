const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('mixerPrototype',{
  settings:()=>ipcRenderer.invoke('prototype-fixture-settings'),save:changes=>ipcRenderer.invoke('prototype-fixture-save',changes),
  chooseAudio:()=>ipcRenderer.invoke('prototype-fixture-track'),cableHelp:async()=>true
});
