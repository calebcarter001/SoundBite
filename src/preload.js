const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('soundbite', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  updateConfig: (updates) => ipcRenderer.invoke('config:update', updates),
  listDevices: () => ipcRenderer.invoke('devices:list'),
  getStatus: () => ipcRenderer.invoke('recorder:status'),
  startAll: () => ipcRenderer.invoke('recorder:startAll'),
  startDevice: (deviceKey) => ipcRenderer.invoke('recorder:startDevice', deviceKey),
  stopAll: () => ipcRenderer.invoke('recorder:stopAll'),
  stopDevice: (deviceKey) => ipcRenderer.invoke('recorder:stopDevice', deviceKey),
  openFolder: () => ipcRenderer.invoke('folder:open'),
  openDeviceFolder: (deviceKey) => ipcRenderer.invoke('folder:openDevice', deviceKey),
  chooseFolder: () => ipcRenderer.invoke('folder:choose'),
  openCasesFolder: () => ipcRenderer.invoke('cases:open'),
  openCaseFolder: (caseDir) => ipcRenderer.invoke('cases:openCase', caseDir),
  openCaseReport: (reportPath) => ipcRenderer.invoke('cases:openReport', reportPath),
  listLibrary: () => ipcRenderer.invoke('library:list'),
  analyzeRecording: (filePath) => ipcRenderer.invoke('recordings:analyze', filePath),
  listVoiceMemos: () => ipcRenderer.invoke('voiceMemos:list'),
  analyzeVoiceMemo: (filePath) => ipcRenderer.invoke('voiceMemos:analyze', filePath),
  analyzeStreamLatest: (deviceKey) => ipcRenderer.invoke('streams:analyzeLatest', deviceKey),
  analyzeStreamWindow: (deviceKey, minutes) => ipcRenderer.invoke('streams:analyzeWindow', deviceKey, minutes),
  checkpointAnalyze: (deviceKey, durationSeconds) => ipcRenderer.invoke('streams:checkpointAnalyze', deviceKey, durationSeconds),
  getLogin: () => ipcRenderer.invoke('login:get'),
  setLogin: (openAtLogin) => ipcRenderer.invoke('login:set', openAtLogin),
  onStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('recorder:status', handler);
    return () => ipcRenderer.removeListener('recorder:status', handler);
  }
});
