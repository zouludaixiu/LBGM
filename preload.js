const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('soundboard', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  getChampions: () => ipcRenderer.invoke('get-champions'),
  getChampionAvatar: id => ipcRenderer.invoke('get-champion-avatar', id),
  getChampionNicknames: force => ipcRenderer.invoke('get-champion-nicknames', Boolean(force)),
  saveSettings: changes => ipcRenderer.invoke('save-settings', changes),
  applyMicGain: gainDb => ipcRenderer.invoke('apply-mic-gain', gainDb),
  reportPlayback: status => ipcRenderer.invoke('report-playback', status),
  chooseAudio: () => ipcRenderer.invoke('choose-audio'),
  readMappedAudio: filePath => ipcRenderer.invoke('read-mapped-audio', filePath),
  chooseLockfile: () => ipcRenderer.invoke('choose-lockfile'),
  beginHotkeyCapture: () => ipcRenderer.invoke('begin-hotkey-capture'),
  cancelHotkeyCapture: () => ipcRenderer.invoke('cancel-hotkey-capture'),
  rendererReady: () => ipcRenderer.invoke('renderer-ready'),
  windowControl: action => ipcRenderer.invoke('window-control', action),
  submitCloseChoice: (action, remember) => ipcRenderer.invoke('close-choice', { action, remember }),
  cableHelp: () => ipcRenderer.invoke('cable-help'),
  openWindowsSound: () => ipcRenderer.invoke('open-windows-sound'),
  wizardComplete: payload => ipcRenderer.invoke('wizard-complete', payload),
  onConfirmClose: callback => ipcRenderer.on('confirm-close', () => callback()),
  onMaximizeState: callback => ipcRenderer.on('maximize-state', (_e, maximized) => callback(maximized)),
  onToggle: callback => ipcRenderer.on('toggle-playback', (_e, payload) => callback(payload)),
  onPause: callback => ipcRenderer.on('pause-playback', callback),
  onRestart: callback => ipcRenderer.on('restart-playback', callback),
  onChampion: callback => ipcRenderer.on('champion-detected', (_e, champion) => callback(champion)),
  onLcuStatus: callback => ipcRenderer.on('lcu-status', (_e, status) => callback(status))
});
