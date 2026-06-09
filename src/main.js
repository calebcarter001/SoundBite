const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { loadConfig, saveConfig } = require('./config');
const { analyzeAudioSources, analyzeVoiceMemo, listVoiceMemos } = require('./forensics');
const { RecordingManager } = require('./recorder');

let mainWindow = null;
let manager = null;
let config = null;
let monitorTimer = null;

function hasLiveWindow() {
  return Boolean(
    mainWindow
      && !mainWindow.isDestroyed()
      && mainWindow.webContents
      && !mainWindow.webContents.isDestroyed()
  );
}

function broadcastStatus() {
  if (hasLiveWindow() && manager) {
    mainWindow.webContents.send('recorder:status', manager.getStatus());
  }
}

function showMainWindow() {
  if (hasLiveWindow()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }

    mainWindow.show();
    mainWindow.focus();
    return;
  }

  if (app.isReady()) {
    createWindow();
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 780,
    minHeight: 560,
    title: 'SoundBite',
    backgroundColor: '#f5f2ed',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function safeStart() {
  if (process.env.SOUNDBITE_DISABLE_AUTO_RECORD === '1' || !config?.autoRecord || !manager) {
    return;
  }

  manager.startAll();
}

function startMonitor() {
  clearInterval(monitorTimer);
  monitorTimer = setInterval(safeStart, 15000);
}

function getLoginSettings() {
  return app.getLoginItemSettings({
    path: process.execPath,
    args: app.isPackaged ? [] : [path.resolve(__dirname, '..')]
  });
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  app.whenReady().then(() => {
    config = loadConfig(app.getPath('userData'));
    manager = new RecordingManager(config);
    config = saveConfig(app.getPath('userData'), manager.config);
    manager.on('status', broadcastStatus);

    createWindow();
    startMonitor();

    setTimeout(safeStart, 1000);
  });
}

app.on('before-quit', async (event) => {
  if (manager?.isRunning()) {
    event.preventDefault();
    await manager.stopAll();
    app.exit(0);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    showMainWindow();
  }
});

ipcMain.handle('config:get', () => manager?.config || config);

ipcMain.handle('config:update', (_event, updates) => {
  config = saveConfig(app.getPath('userData'), { ...config, ...updates });
  manager.updateConfig(config);
  config = saveConfig(app.getPath('userData'), manager.config);
  safeStart();
  return config;
});

ipcMain.handle('devices:list', () => {
  const devices = manager.listAudioDevices();
  config = saveConfig(app.getPath('userData'), manager.config);
  return devices;
});

ipcMain.handle('recorder:status', () => manager.getStatus());

ipcMain.handle('recorder:startAll', () => manager.startAll());

ipcMain.handle('recorder:startDevice', (_event, deviceKey) => manager.startDevice(deviceKey));

ipcMain.handle('recorder:stopDevice', async (_event, deviceKey) => manager.stopDevice(deviceKey));

ipcMain.handle('recorder:stopAll', async () => manager.stopAll());

ipcMain.handle('folder:open', async () => {
  await shell.openPath(config.recordingsDir);
  return manager.getStatus();
});

ipcMain.handle('folder:openDevice', async (_event, deviceKey) => {
  const status = manager.getStatus();
  const device = status.devices.find((candidate) => candidate.key === deviceKey);
  const session = status.sessions.find((candidate) => candidate.key === deviceKey);
  const folder = session?.recordingsDir || device?.recordingsDir || config.recordingsDir;

  await shell.openPath(folder);
  return manager.getStatus();
});

ipcMain.handle('folder:choose', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose recordings folder',
    defaultPath: config.recordingsDir,
    properties: ['openDirectory', 'createDirectory']
  });

  if (result.canceled || !result.filePaths[0]) {
    return config;
  }

  config = saveConfig(app.getPath('userData'), {
    ...config,
    recordingsDir: result.filePaths[0]
  });
  manager.updateConfig(config);
  return config;
});

ipcMain.handle('cases:open', async () => {
  await shell.openPath(config.casesDir);
  return config;
});

ipcMain.handle('voiceMemos:list', () => listVoiceMemos(80));

ipcMain.handle('voiceMemos:analyze', async (_event, filePath) => analyzeVoiceMemo(filePath, {
  casesDir: config.casesDir
}));

ipcMain.handle('streams:analyzeLatest', async (_event, deviceKey) => {
  const sources = manager.analysisSourcesForDevice(deviceKey, { mode: 'latest' });

  if (!sources.length) {
    throw new Error('No finalized snapshots are available for this mic yet. Use a checkpoint for current audio.');
  }

  return analyzeAudioSources(sources, {
    casesDir: config.casesDir,
    caseLabel: `${sources[0].device?.targetName || sources[0].device?.displayName || 'stream'} latest`
  });
});

ipcMain.handle('streams:analyzeWindow', async (_event, deviceKey, minutes) => {
  const sourceMinutes = Math.min(Math.max(Number.parseFloat(minutes) || 30, 1), 1440);
  const sources = manager.analysisSourcesForDevice(deviceKey, {
    mode: 'window',
    minutes: sourceMinutes
  });

  if (!sources.length) {
    throw new Error(`No finalized snapshots overlap the last ${sourceMinutes} minutes for this mic. Use a checkpoint for current audio.`);
  }

  return analyzeAudioSources(sources, {
    casesDir: config.casesDir,
    caseLabel: `${sources[0].device?.targetName || sources[0].device?.displayName || 'stream'} last ${sourceMinutes} minutes`
  });
});

ipcMain.handle('streams:checkpointAnalyze', async (_event, deviceKey, durationSeconds) => {
  const checkpointSeconds = Math.min(Math.max(Number.parseInt(durationSeconds, 10) || 60, 5), 86400);
  const source = await manager.captureCheckpoint(deviceKey, {
    casesDir: config.casesDir,
    durationSeconds: checkpointSeconds
  });

  return analyzeAudioSources([source], {
    casesDir: config.casesDir,
    caseLabel: `${source.device?.targetName || source.device?.displayName || 'stream'} checkpoint`
  });
});

ipcMain.handle('login:get', () => getLoginSettings());

ipcMain.handle('login:set', (_event, openAtLogin) => {
  app.setLoginItemSettings({
    openAtLogin: Boolean(openAtLogin),
    path: process.execPath,
    args: app.isPackaged ? [] : [path.resolve(__dirname, '..')]
  });

  return getLoginSettings();
});
