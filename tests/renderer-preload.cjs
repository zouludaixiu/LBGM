const { contextBridge, ipcRenderer } = require('electron');
const callbacks = {};
contextBridge.exposeInMainWorld('soundboard', {
  getSettings: () => ipcRenderer.invoke('fixture-settings'),
  saveSettings: changes => ipcRenderer.invoke('fixture-save', changes),
  getChampions: async () => [{ id:157, name:'疾风剑豪', alias:'Yasuo' }, { id:266, name:'暗裔剑魔', alias:'Aatrox' }],
  getChampionNicknames: async () => ({ 疾风剑豪:'亚索', 暗裔剑魔:'亚托克斯' }),
  getChampionAvatar: async () => null,
  chooseAudio: () => ipcRenderer.invoke('fixture-track'),
  reportPlayback: async () => true,
  rendererReady: async () => true,
  beginHotkeyCapture: async () => ({ ok:true }),
  cancelHotkeyCapture: async () => true,
  windowControl: async () => true,
  onToggle: fn => { callbacks.toggle = fn; },
  onPause: fn => { callbacks.pause = fn; },
  onRestart: fn => { callbacks.restart = fn; },
  simulateRestart: () => callbacks.restart(),
  onChampion: fn => { callbacks.champion = fn; },
  onLcuStatus: fn => { callbacks.lcu = fn; },
  onConfirmClose: () => {}, onMaximizeState: () => {},
  onAudioSetupStatus: () => {},
  vmStatus: async () => ({ installed:true }),
  wizardComplete: payload => ipcRenderer.invoke('fixture-wizard',payload),
  simulateChampion: value => callbacks.champion(value)
});
