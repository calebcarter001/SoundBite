const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { app, BrowserWindow, dialog, ipcMain, session, shell, systemPreferences } = require('electron');
const { createAuditLogger } = require('./audit-log');
const { loadConfig, saveConfig } = require('./config');
const { analyzeAudioFile, analyzeAudioSources, analyzeVoiceMemo, listVoiceMemos } = require('./forensics');
const { RecordingManager, snapshotStartedAtFromName } = require('./recorder');

let mainWindow = null;
let manager = null;
let config = null;
let monitorTimer = null;
let auditLogger = null;

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

function isAudioOnlyMediaRequest(details = {}) {
  const mediaTypes = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
  return mediaTypes.includes('audio') && !mediaTypes.includes('video');
}

function permissionDetails(details = {}) {
  return {
    mediaTypes: Array.isArray(details.mediaTypes) ? details.mediaTypes : [],
    requestingUrl: details.requestingUrl || null,
    securityOrigin: details.securityOrigin || null,
    embeddingOrigin: details.embeddingOrigin || null
  };
}

function devicePermissionDetails(details = {}) {
  return {
    origin: details.origin || null,
    deviceType: details.deviceType || null,
    device: details.device ? {
      deviceId: details.device.deviceId || null,
      name: details.device.name || null,
      productName: details.device.productName || null,
      serialNumber: details.device.serialNumber || null,
      vendorId: details.device.vendorId || null,
      productId: details.device.productId || null
    } : null
  };
}

function displayMediaRequestDetails(request = {}) {
  return {
    securityOrigin: request.securityOrigin || null,
    frameUrl: request.frame?.url || null,
    videoRequested: Boolean(request.videoRequested),
    audioRequested: Boolean(request.audioRequested)
  };
}

function configureDevicePermissionPolicy(logger) {
  const browserSession = session.defaultSession;

  browserSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    const allowed = permission === 'media' && isAudioOnlyMediaRequest(details);

    if (!allowed) {
      logger?.log('electron-permission-check-denied', {
        permission,
        requestingOrigin,
        details: permissionDetails(details)
      }, {
        dedupeKey: `permission-check:${permission}:${requestingOrigin}`,
        minIntervalMs: 5000
      });
    }

    return allowed;
  });

  browserSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const allowed = permission === 'media' && isAudioOnlyMediaRequest(details);

    if (!allowed) {
      logger?.log('electron-permission-request-denied', {
        permission,
        details: permissionDetails(details)
      }, {
        dedupeKey: `permission-request:${permission}`,
        minIntervalMs: 5000
      });
    }

    callback(allowed);
  });

  browserSession.setDevicePermissionHandler((details) => {
    const summarized = devicePermissionDetails(details);
    logger?.log('electron-device-permission-denied', summarized, {
      dedupeKey: `device-permission:${details?.deviceType || 'unknown'}:${details?.origin || ''}`,
      minIntervalMs: 5000
    });
    return false;
  });

  browserSession.setDisplayMediaRequestHandler((request, callback) => {
    logger?.log('electron-display-media-request-denied', displayMediaRequestDetails(request), {
      dedupeKey: `display-media:${request?.securityOrigin || ''}`,
      minIntervalMs: 5000
    });
    callback({});
  });
}

async function ensureMicrophoneAccess() {
  if (process.platform !== 'darwin') {
    return true;
  }

  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'granted') {
    return true;
  }

  if (status === 'denied' || status === 'restricted') {
    return false;
  }

  return systemPreferences.askForMediaAccess('microphone');
}

async function safeStart() {
  if (process.env.SOUNDBITE_DISABLE_AUTO_RECORD === '1' || !config?.autoRecord || !manager) {
    return;
  }

  if (!(await ensureMicrophoneAccess())) {
    manager.lastError = 'Microphone permission is not granted for SoundBite. Grant access in macOS Privacy & Security settings, then restart recording.';
    manager.emitStatus();
    return;
  }

  manager.startAll();
}

function startMonitor() {
  clearInterval(monitorTimer);
  monitorTimer = setInterval(() => {
    safeStart().catch((error) => {
      if (manager) {
        manager.lastError = error.message;
        manager.emitStatus();
      }
    });
  }, 15000);
}

function getLoginSettings() {
  return app.getLoginItemSettings({
    path: process.execPath,
    args: app.isPackaged ? [] : [path.resolve(__dirname, '..')]
  });
}

function updateRecorderConfig(updates) {
  config = saveConfig(app.getPath('userData'), { ...config, ...updates });
  manager.updateConfig(config);
  config = saveConfig(app.getPath('userData'), manager.config);
  return config;
}

function disableAutoRecordForManualStop() {
  if (config?.autoRecord) {
    updateRecorderConfig({ autoRecord: false });
  }
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function listAudioFiles(rootDir, limit = 250) {
  const files = [];

  function walk(dir) {
    if (files.length >= limit || !fs.existsSync(dir)) {
      return;
    }

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === 'discarded-snapshots') {
          continue;
        }
        walk(filePath);
      } else if (/\.(m4a|wav|aac|flac|caf)$/i.test(entry.name)) {
        const stat = fs.statSync(filePath);
        files.push({
          name: entry.name,
          path: filePath,
          relativePath: path.relative(rootDir, filePath),
          folder: path.dirname(path.relative(rootDir, filePath)),
          bytes: stat.size,
          createdAt: stat.birthtime.toISOString(),
          modifiedAt: stat.mtime.toISOString(),
          startedAt: snapshotStartedAtFromName(entry.name) || stat.birthtime.toISOString()
        });
      }
    }
  }

  try {
    walk(rootDir);
  } catch (error) {
    console.warn(`Failed to list recordings: ${error.message}`);
  }

  return files
    .sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime())
    .slice(0, limit);
}

function listCaseManifests(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  try {
    return fs.readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const caseDir = path.join(rootDir, entry.name);
        const manifestPath = path.join(caseDir, 'manifest.json');
        if (!fs.existsSync(manifestPath)) {
          return null;
        }

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        return {
          caseId: manifest.caseId || entry.name,
          caseDir,
          manifestPath,
          createdAt: manifest.createdAt || null,
          sourceCount: Array.isArray(manifest.sources) ? manifest.sources.length : manifest.source ? 1 : 0,
          clipCount: Array.isArray(manifest.clips) ? manifest.clips.length : 0,
          collectionCount: Array.isArray(manifest.similarityCollections) ? manifest.similarityCollections.length : 0,
          clips: Array.isArray(manifest.clips) ? manifest.clips.slice(0, 8) : [],
          similarityCollections: Array.isArray(manifest.similarityCollections)
            ? manifest.similarityCollections.slice(0, 6)
            : [],
          source: manifest.source || null,
          analysis: manifest.analysis || null,
          grouping: manifest.grouping || null,
          report: manifest.report || null
        };
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
  } catch (error) {
    console.warn(`Failed to list cases: ${error.message}`);
    return [];
  }
}

function diskSummary(targetDir) {
  const dir = fs.existsSync(targetDir) ? targetDir : path.dirname(targetDir);
  const result = spawnSync('/bin/df', ['-k', dir], { encoding: 'utf8' });

  if (result.status !== 0) {
    return null;
  }

  const lines = result.stdout.trim().split(/\r?\n/);
  const columns = lines.at(-1)?.trim().split(/\s+/);
  const availableKb = Number.parseInt(columns?.[3], 10);

  if (!Number.isFinite(availableKb)) {
    return null;
  }

  return {
    availableBytes: availableKb * 1024,
    mount: columns.at(-1)
  };
}

function librarySnapshot() {
  const recordings = listAudioFiles(config.recordingsDir);
  const cases = listCaseManifests(config.casesDir);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayRecordings = recordings.filter((recording) => new Date(recording.modifiedAt) >= todayStart);

  return {
    recordings,
    cases,
    disk: diskSummary(config.recordingsDir),
    summary: {
      recordingCount: recordings.length,
      todayRecordingCount: todayRecordings.length,
      todayBytes: todayRecordings.reduce((total, recording) => total + recording.bytes, 0),
      caseCount: cases.length,
      clipCount: cases.reduce((total, item) => total + item.clipCount, 0),
      collectionCount: cases.reduce((total, item) => total + item.collectionCount, 0)
    }
  };
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  app.whenReady().then(() => {
    auditLogger = createAuditLogger(app.getPath('userData'));
    configureDevicePermissionPolicy(auditLogger);
    config = loadConfig(app.getPath('userData'));
    manager = new RecordingManager(config, { auditLogger });
    config = saveConfig(app.getPath('userData'), manager.config);
    manager.on('status', broadcastStatus);

    createWindow();
    startMonitor();

    setTimeout(() => {
      safeStart().catch((error) => {
        manager.lastError = error.message;
        manager.emitStatus();
      });
    }, 1000);
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
  safeStart().catch((error) => {
    manager.lastError = error.message;
    manager.emitStatus();
  });
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

ipcMain.handle('recorder:stopDevice', async (_event, deviceKey) => {
  disableAutoRecordForManualStop();
  return manager.stopDevice(deviceKey);
});

ipcMain.handle('recorder:stopAll', async () => {
  disableAutoRecordForManualStop();
  return manager.stopAll();
});

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

ipcMain.handle('library:list', () => librarySnapshot());

ipcMain.handle('recordings:analyze', async (_event, filePath) => {
  const sourcePath = path.resolve(filePath);
  if (!isInside(config.recordingsDir, sourcePath)) {
    throw new Error('Recording path is outside the configured SoundBite recordings folder.');
  }

  return analyzeAudioFile(sourcePath, {
    casesDir: config.casesDir,
    sourceType: 'stream-snapshot'
  });
});

ipcMain.handle('cases:openCase', async (_event, caseDir) => {
  const targetDir = path.resolve(caseDir);
  if (!isInside(config.casesDir, targetDir)) {
    throw new Error('Case folder is outside the configured SoundBite cases folder.');
  }

  await shell.openPath(targetDir);
  return librarySnapshot();
});

ipcMain.handle('cases:openReport', async (_event, reportPath) => {
  const targetPath = path.resolve(reportPath);
  if (!isInside(config.casesDir, targetPath)) {
    throw new Error('Case report is outside the configured SoundBite cases folder.');
  }

  await shell.openPath(targetPath);
  return librarySnapshot();
});

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
