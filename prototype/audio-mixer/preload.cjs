const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('mixerPrototype',{
  settings:()=>ipcRenderer.invoke('prototype-settings'),save:changes=>ipcRenderer.invoke('prototype-save',changes),
  chooseAudio:()=>ipcRenderer.invoke('prototype-audio'),cableHelp:()=>ipcRenderer.invoke('prototype-cable-help')
});
