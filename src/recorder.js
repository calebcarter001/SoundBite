const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { batteryStatusForAudioDevice, listHidBatteryReports } = require('./battery');
const { resolveExecutable } = require('./bin');
const {
  DEFAULT_CONFIG,
  ensureMicProfilesForDevices,
  normalizeConfig
} = require('./config');
const {
  annotateAudioDeviceSecurity,
  deviceSecurityError,
  listCoreAudioInputDevices,
  listUsbControlDevices,
  securitySummary
} = require('./device-policy');

function slugify(value) {
  const slug = String(value || 'device')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || 'device';
}

function parseAvfoundationDevices(output) {
  const devices = { video: [], audio: [] };
  let section = null;

  for (const line of String(output || '').split(/\r?\n/)) {
    if (line.includes('AVFoundation video devices:')) {
      section = 'video';
      continue;
    }

    if (line.includes('AVFoundation audio devices:')) {
      section = 'audio';
      continue;
    }

    const match = line.match(/\]\s+\[(\d+)]\s+(.+)$/);
    if (!section || !match) {
      continue;
    }

    devices[section].push({
      index: Number.parseInt(match[1], 10),
      name: match[2].trim()
    });
  }

  return devices;
}

function annotateAudioDevices(audioDevices) {
  const totals = new Map();
  const seen = new Map();

  for (const device of audioDevices) {
    totals.set(device.name, (totals.get(device.name) || 0) + 1);
  }

  return audioDevices.map((device) => {
    const occurrence = (seen.get(device.name) || 0) + 1;
    seen.set(device.name, occurrence);

    const duplicateCount = totals.get(device.name) || 1;
    const nameSlug = slugify(device.name);
    const displayName = duplicateCount > 1 ? `${device.name} #${occurrence}` : device.name;

    return {
      ...device,
      key: `avfoundation-${device.index}-${nameSlug}`,
      nameSlug,
      displayName,
      occurrence,
      duplicateCount
    };
  });
}

function findAudioDevice(devices, targetDeviceName) {
  const audioDevices = Array.isArray(devices?.audio) ? devices.audio : [];
  const target = String(targetDeviceName || '').toLowerCase();

  return audioDevices.find((device) => device.name.toLowerCase() === target)
    || audioDevices.find((device) => device.name.toLowerCase().includes(target))
    || null;
}

function matchesTargetDevice(device, config) {
  const normalized = normalizeConfig(config);
  const profile = normalized.micProfiles[device?.key];

  return Boolean(profile?.enabled);
}

function profileForDevice(config, device) {
  const normalized = normalizeConfig(config);
  return normalized.micProfiles[device?.key] || {
    targetName: device.displayName || device.name,
    folderName: `${slugify(device.displayName || device.name)}-index-${device.index}`,
    enabled: false
  };
}

function recordingDirForDevice(config, device) {
  const normalized = normalizeConfig(config);
  const profile = profileForDevice(normalized, device);
  const folderName = slugify(profile.folderName || profile.targetName || device.displayName || device.name);
  return path.join(normalized.recordingsDir, folderName);
}

function buildFfmpegArgs(device, config) {
  const normalized = normalizeConfig(config);
  const profile = profileForDevice(normalized, device);
  const deviceDir = recordingDirForDevice(normalized, device);
  const outputPattern = path.join(deviceDir, `${slugify(profile.targetName || device.displayName || device.name)}-%Y%m%d-%H%M%S.m4a`);

  return [
    '-hide_banner',
    '-loglevel',
    'info',
    '-f',
    'avfoundation',
    '-i',
    `:${device.index}`,
    '-vn',
    '-c:a',
    'aac',
    '-b:a',
    normalized.audioBitrate,
    '-f',
    'segment',
    '-segment_time',
    String(normalized.segmentSeconds),
    '-reset_timestamps',
    '1',
    '-strftime',
    '1',
    outputPattern
  ];
}

function buildCheckpointFfmpegArgs(device, outputPath, config, durationSeconds) {
  const normalized = normalizeConfig(config);
  const seconds = Math.min(Math.max(Number.parseInt(durationSeconds, 10) || 60, 5), 86400);

  return [
    '-hide_banner',
    '-y',
    '-nostdin',
    '-f',
    'avfoundation',
    '-i',
    `:${device.index}`,
    '-t',
    String(seconds),
    '-vn',
    '-c:a',
    'aac',
    '-b:a',
    normalized.audioBitrate,
    outputPath
  ];
}

function resolveAudioHogWrapper() {
  if (process.platform !== 'darwin') {
    return null;
  }

  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'macos-audio-hog-wrapper') : null,
    __dirname.includes('.asar') ? null : path.join(__dirname, 'macos-audio-hog-wrapper')
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (_error) {
      // Keep scanning. The packaged app keeps native helpers outside app.asar.
    }
  }

  return null;
}

function ffmpegSpawnCommand(device, args, config) {
  const normalized = normalizeConfig(config);
  const ffmpegPath = resolveExecutable('ffmpeg');

  if (!normalized.exclusiveAudioAccess || process.platform !== 'darwin') {
    return {
      command: ffmpegPath,
      args,
      display: `$ ${ffmpegPath} ${args.join(' ')}`
    };
  }

  const wrapperPath = resolveAudioHogWrapper();
  if (!wrapperPath) {
    throw new Error('Exclusive audio access is enabled, but the macOS audio lock helper was not found. Run npm run build:helper and repackage SoundBite.');
  }

  const wrapperArgs = [
    '--device-name',
    device.name,
    '--device-occurrence',
    String(device.occurrence || 1),
    '--',
    ffmpegPath,
    ...args
  ];

  return {
    command: wrapperPath,
    args: wrapperArgs,
    display: `$ ${wrapperPath} --device-name "${device.name}" --device-occurrence ${device.occurrence || 1} -- ${ffmpegPath} ${args.join(' ')}`
  };
}

function parseMaxVolume(output) {
  const match = String(output || '').match(/max_volume:\s*(-inf|-?\d+(?:\.\d+)?)\s*dB/);

  if (!match) {
    return null;
  }

  return match[1] === '-inf' ? -Infinity : Number.parseFloat(match[1]);
}

function shouldDiscardSnapshot(maxVolumeDb, silenceMaxVolumeDb) {
  return Number.isFinite(maxVolumeDb)
    ? maxVolumeDb <= silenceMaxVolumeDb
    : maxVolumeDb === -Infinity;
}

function snapshotSidecarPath(filePath) {
  return `${filePath}.json`;
}

function discardedSnapshotPath(filePath) {
  return path.join(path.dirname(filePath), 'discarded-snapshots', `${path.basename(filePath)}.json`);
}

function listSnapshotFiles(recordingsDir) {
  try {
    return fs.readdirSync(recordingsDir)
      .filter((name) => name.toLowerCase().endsWith('.m4a'))
      .map((name) => {
        const filePath = path.join(recordingsDir, name);
        const stat = fs.statSync(filePath);

        return {
          name,
          path: filePath,
          bytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          modifiedMs: stat.mtimeMs
        };
      })
      .sort((a, b) => a.modifiedMs - b.modifiedMs);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Failed to list snapshot files: ${error.message}`);
    }

    return [];
  }
}

function snapshotTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');

  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('') + '-' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('');
}

function snapshotStartedAtFromName(name) {
  const match = String(name || '').match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.m4a$/i);

  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(
    Number.parseInt(year, 10),
    Number.parseInt(month, 10) - 1,
    Number.parseInt(day, 10),
    Number.parseInt(hour, 10),
    Number.parseInt(minute, 10),
    Number.parseInt(second, 10)
  );

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);

    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function analyzeSnapshotVolume(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveExecutable('ffmpeg'), [
      '-hide_banner',
      '-nostdin',
      '-i',
      filePath,
      '-map',
      '0:a:0',
      '-af',
      'volumedetect',
      '-f',
      'null',
      '-'
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg volumedetect exited with code ${code}`));
        return;
      }

      resolve({
        maxVolumeDb: parseMaxVolume(stderr),
        raw: stderr
      });
    });
  });
}

function latestRecording(recordingsDir) {
  try {
    const files = fs.readdirSync(recordingsDir)
      .filter((name) => name.toLowerCase().endsWith('.m4a'))
      .map((name) => {
        const filePath = path.join(recordingsDir, name);
        const stat = fs.statSync(filePath);

        return {
          name,
          path: filePath,
          bytes: stat.size,
          modifiedAt: stat.mtime.toISOString()
        };
      })
      .sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

    return files[0] || null;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Failed to inspect recordings folder: ${error.message}`);
    }

    return null;
  }
}

function isActiveChildProcess(child) {
  return Boolean(child && child.exitCode === null && child.signalCode === null);
}

function listAvfoundationAudioDevices() {
  const result = spawnSync(resolveExecutable('ffmpeg'), ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], {
    encoding: 'utf8'
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;

  return annotateAudioDevices(parseAvfoundationDevices(output).audio);
}

class DeviceRecorder extends EventEmitter {
  constructor(device, config = DEFAULT_CONFIG) {
    super();
    this.device = device;
    this.config = normalizeConfig(config);
    this.child = null;
    this.startedAt = null;
    this.stopping = false;
    this.lastError = null;
    this.recentLog = [];
    this.cleanupTimer = null;
    this.cleanupInProgress = false;
    this.stopPromise = null;
  }

  updateConfig(config) {
    const wasRunning = this.isRunning();
    this.config = normalizeConfig(config);

    if (!wasRunning) {
      this.emitStatus();
    }

    return this.getStatus();
  }

  updateDevice(device) {
    this.device = device;
    return this.getStatus();
  }

  isRunning() {
    return isActiveChildProcess(this.child);
  }

  start() {
    if (this.isRunning() || this.stopping || this.stopPromise) {
      return this.getStatus();
    }

    const deviceDir = recordingDirForDevice(this.config, this.device);
    fs.mkdirSync(deviceDir, { recursive: true });

    const args = buildFfmpegArgs(this.device, this.config);
    this.startedAt = new Date().toISOString();
    this.lastError = null;
    this.stopping = false;
    let spawnCommand;

    try {
      spawnCommand = ffmpegSpawnCommand(this.device, args, this.config);
    } catch (error) {
      this.lastError = error.message;
      this.startedAt = null;
      this.emitStatus();
      return this.getStatus();
    }

    this.pushLog(spawnCommand.display);

    this.child = spawn(spawnCommand.command, spawnCommand.args, {
      stdio: ['pipe', 'ignore', 'pipe']
    });

    this.child.stderr.on('data', (chunk) => this.pushLog(chunk.toString()));
    this.child.on('error', (error) => {
      this.lastError = error.message;
      this.emitStatus();
    });
    this.child.on('exit', (code, signal) => {
      if (!this.stopping && code !== 0) {
        this.lastError = `${this.device.displayName} ffmpeg exited with code ${code}${signal ? ` and signal ${signal}` : ''}.`;
      }

      this.stopCleanupTimer();
      this.child = null;
      this.startedAt = null;
      this.stopping = false;
      this.scanSnapshots({ includeLatest: true }).catch((error) => {
        this.pushLog(`Snapshot cleanup failed: ${error.message}`);
      });
      this.emitStatus();
    });

    this.startCleanupTimer();
    this.emitStatus();
    return this.getStatus();
  }

  stop() {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    if (!this.child || !this.isRunning()) {
      return Promise.resolve(this.getStatus());
    }

    this.stopping = true;
    const child = this.child;

    this.stopPromise = new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (isActiveChildProcess(child)) {
          child.kill('SIGTERM');
        }
      }, 3000);

      child.once('exit', () => {
        clearTimeout(timeout);
        this.scanSnapshots({ includeLatest: true })
          .catch((error) => {
            this.pushLog(`Snapshot cleanup failed: ${error.message}`);
          })
          .finally(() => resolve(this.getStatus()));
      });

      try {
        child.stdin.write('q');
        child.stdin.end();
      } catch (_error) {
        child.kill('SIGTERM');
      }
    }).finally(() => {
      this.stopPromise = null;
    });

    return this.stopPromise;
  }

  startCleanupTimer() {
    this.stopCleanupTimer();
    this.cleanupTimer = setInterval(() => {
      this.scanSnapshots().catch((error) => {
        this.pushLog(`Snapshot cleanup failed: ${error.message}`);
      });
    }, 60000);
  }

  stopCleanupTimer() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  async scanSnapshots(options = {}) {
    if (this.cleanupInProgress) {
      return;
    }

    this.cleanupInProgress = true;

    try {
      const normalized = normalizeConfig(this.config);
      if (!normalized.discardSilenceSnapshots) {
        return;
      }

      const recordingsDir = recordingDirForDevice(normalized, this.device);
      const snapshots = listSnapshotFiles(recordingsDir);
      const newestPath = snapshots.at(-1)?.path;
      const now = Date.now();

      for (const snapshot of snapshots) {
        if (!options.includeLatest && snapshot.path === newestPath && this.isRunning()) {
          continue;
        }

        if (!options.includeLatest && now - snapshot.modifiedMs < normalized.snapshotFinalizeGraceSeconds * 1000) {
          continue;
        }

        if (fs.existsSync(snapshotSidecarPath(snapshot.path)) || fs.existsSync(discardedSnapshotPath(snapshot.path))) {
          continue;
        }

        const volume = await analyzeSnapshotVolume(snapshot.path);
        const discard = shouldDiscardSnapshot(volume.maxVolumeDb, normalized.silenceMaxVolumeDb);
        const metadata = {
          kind: discard ? 'discarded-silence-snapshot' : 'kept-snapshot',
          device: {
            key: this.device.key,
            name: this.device.name,
            displayName: this.device.displayName,
            index: this.device.index
          },
          file: {
            name: snapshot.name,
            path: snapshot.path,
            bytes: snapshot.bytes,
            modifiedAt: snapshot.modifiedAt
          },
          policy: {
            silenceMaxVolumeDb: normalized.silenceMaxVolumeDb,
            segmentSeconds: normalized.segmentSeconds
          },
          analysis: {
            maxVolumeDb: volume.maxVolumeDb
          },
          processedAt: new Date().toISOString()
        };

        if (discard) {
          fs.mkdirSync(path.dirname(discardedSnapshotPath(snapshot.path)), { recursive: true });
          fs.writeFileSync(discardedSnapshotPath(snapshot.path), `${JSON.stringify(metadata, null, 2)}\n`);
          fs.unlinkSync(snapshot.path);
          this.pushLog(`Discarded silence-only snapshot ${snapshot.name}`);
        } else {
          metadata.file.sha256 = await hashFile(snapshot.path);
          fs.writeFileSync(snapshotSidecarPath(snapshot.path), `${JSON.stringify(metadata, null, 2)}\n`);
          this.pushLog(`Kept snapshot ${snapshot.name}`);
        }
      }
    } finally {
      this.cleanupInProgress = false;
    }
  }

  getStatus() {
    const recordingsDir = recordingDirForDevice(this.config, this.device);

    return {
      key: this.device.key,
      name: this.device.name,
      displayName: this.device.displayName,
      index: this.device.index,
      running: this.isRunning(),
      pid: this.child?.pid || null,
      device: this.device,
      startedAt: this.startedAt,
      recordingsDir,
      latestRecording: latestRecording(recordingsDir),
      lastError: this.lastError,
      cleanupInProgress: this.cleanupInProgress,
      recentLog: this.recentLog.slice(-40)
    };
  }

  pushLog(text) {
    const lines = String(text)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    this.recentLog.push(...lines);
    this.recentLog = this.recentLog.slice(-80);
    this.emitStatus();
  }

  emitStatus() {
    this.emit('status', this.getStatus());
  }
}

class RecordingManager extends EventEmitter {
  constructor(config = DEFAULT_CONFIG, options = {}) {
    super();
    this.config = normalizeConfig(config);
    this.sessions = new Map();
    this.devices = [];
    this.batteryReports = [];
    this.batteryReportsUpdatedAt = 0;
    this.usbControlDevices = [];
    this.auditLogger = options.auditLogger || null;
    this.lastError = null;
    this.refreshDevices('startup');
  }

  audit(kind, details = {}, options = {}) {
    if (!this.auditLogger) {
      return null;
    }

    return this.auditLogger.log(kind, details, options);
  }

  updateConfig(config) {
    this.config = normalizeConfig(config);
    this.refreshDevices('config-update');

    for (const session of this.sessions.values()) {
      session.updateConfig(this.config);
    }

    this.emitStatus();
    return this.getStatus();
  }

  refreshDevices(reason = 'refresh') {
    const now = Date.now();
    if (now - this.batteryReportsUpdatedAt > 60000) {
      this.batteryReports = listHidBatteryReports();
      this.batteryReportsUpdatedAt = now;
    }

    const coreAudioInputDevices = listCoreAudioInputDevices();
    const audioDevices = annotateAudioDeviceSecurity(listAvfoundationAudioDevices(), {
      coreAudioInputDevices,
      usbControlDevices: listUsbControlDevices(this.batteryReports),
      policy: this.config.deviceSecurityPolicy
    });
    const ensured = ensureMicProfilesForDevices(this.config, audioDevices);
    this.config = ensured.config;
    this.usbControlDevices = listUsbControlDevices(this.batteryReports);

    for (const device of audioDevices) {
      const profile = this.config.micProfiles[device.key];
      if (profile?.enabled && !device.security.allowed) {
        this.config.micProfiles[device.key] = {
          ...profile,
          enabled: false
        };
      }
    }

    this.devices = audioDevices.map((device) => ({
      ...device,
      captureEnabled: device.security.allowed && matchesTargetDevice(device, this.config),
      recordingsDir: recordingDirForDevice(this.config, device),
      profile: profileForDevice(this.config, device),
      battery: batteryStatusForAudioDevice(device, this.batteryReports)
    }));

    for (const device of this.devices) {
      const session = this.sessions.get(device.key);
      if (session) {
        session.updateDevice(device);
      }
    }

    this.stopOrphanedSessions(new Set(this.devices.map((device) => device.key)));
    this.stopBlockedSessions(new Set(this.devices.filter((device) => device.security.allowed).map((device) => device.key)));
    this.auditDeviceProbe(reason, coreAudioInputDevices);

    return this.devices;
  }

  auditDeviceProbe(reason, coreAudioInputDevices) {
    const devices = this.devices.map((device) => ({
      key: device.key,
      index: device.index,
      name: device.name,
      displayName: device.displayName,
      captureEnabled: device.captureEnabled,
      security: {
        allowed: device.security?.allowed || false,
        reason: device.security?.reason || null,
        detail: device.security?.detail || null,
        transport: device.security?.transport || null,
        controlInterfaceCount: device.security?.controlInterfaceCount || 0
      }
    }));
    const summary = securitySummary(this.devices, this.usbControlDevices);
    const signature = JSON.stringify({
      devices: devices.map((device) => ({
        key: device.key,
        captureEnabled: device.captureEnabled,
        allowed: device.security.allowed,
        reason: device.security.reason,
        transport: device.security.transport
      })),
      usbControlDeviceCount: summary.usbControlDeviceCount
    });

    this.audit('device-probe', {
      reason,
      coreAudioInputCount: coreAudioInputDevices.length,
      avfoundationInputCount: this.devices.length,
      summary,
      devices
    }, {
      dedupeKey: `device-probe:${signature}`,
      minIntervalMs: reason === 'target-selection' ? 60000 : 5000
    });
  }

  stopOrphanedSessions(currentDeviceKeys) {
    for (const [key, session] of this.sessions.entries()) {
      if (currentDeviceKeys.has(key)) {
        continue;
      }

      if (!session.isRunning()) {
        this.sessions.delete(key);
        continue;
      }

      if (session.stopping) {
        continue;
      }

      session.pushLog('Audio input is no longer present. Stopping stale recorder session.');
      session.stop()
        .catch((error) => {
          session.lastError = `Failed to stop stale recorder session: ${error.message}`;
        })
        .finally(() => {
          this.sessions.delete(key);
          this.emitStatus();
        });
    }
  }

  stopBlockedSessions(allowedDeviceKeys) {
    for (const [key, session] of this.sessions.entries()) {
      if (allowedDeviceKeys.has(key)) {
        continue;
      }

      if (!session.isRunning()) {
        this.sessions.delete(key);
        continue;
      }

      if (session.stopping) {
        continue;
      }

      session.pushLog('Audio input is blocked by the SoundBite device security policy. Stopping recorder session.');
      session.stop()
        .catch((error) => {
          session.lastError = `Failed to stop blocked recorder session: ${error.message}`;
        })
        .finally(() => {
          this.sessions.delete(key);
          this.emitStatus();
        });
    }
  }

  listAudioDevices() {
    return this.refreshDevices('manual-list');
  }

  targetDevices() {
    return this.refreshDevices('target-selection').filter((device) => device.captureEnabled);
  }

  deviceByKey(deviceKey) {
    const devices = this.refreshDevices('device-lookup');
    const device = devices.find((candidate) => candidate.key === deviceKey);

    if (!device) {
      throw new Error(`Audio input ${deviceKey} was not found.`);
    }

    return device;
  }

  snapshotAnalysisSource(device, snapshot) {
    const profile = profileForDevice(this.config, device);
    const recordingStartedAt = snapshotStartedAtFromName(snapshot.name) || snapshot.modifiedAt;

    return {
      path: snapshot.path,
      label: `${profile.targetName || device.displayName} ${snapshot.name}`,
      relativePath: path.join(path.basename(recordingDirForDevice(this.config, device)), snapshot.name),
      sourceType: 'stream-snapshot',
      recordingStartedAt,
      device: {
        key: device.key,
        name: device.name,
        displayName: device.displayName,
        index: device.index,
        targetName: profile.targetName,
        folderName: profile.folderName
      },
      snapshot: {
        name: snapshot.name,
        bytes: snapshot.bytes,
        modifiedAt: snapshot.modifiedAt
      }
    };
  }

  finalizedSnapshotSources(deviceKey, options = {}) {
    const device = this.deviceByKey(deviceKey);
    const normalized = normalizeConfig(this.config);
    const snapshots = listSnapshotFiles(recordingDirForDevice(normalized, device));
    const session = this.sessions.get(device.key);
    const newestPath = snapshots.at(-1)?.path;
    const now = Date.now();
    const minutes = Number.parseFloat(options.minutes);
    const cutoffMs = Number.isFinite(minutes) && minutes > 0 ? now - minutes * 60000 : null;

    return snapshots
      .filter((snapshot) => {
        if (session?.isRunning() && snapshot.path === newestPath) {
          return false;
        }

        if (session?.isRunning() && now - snapshot.modifiedMs < normalized.snapshotFinalizeGraceSeconds * 1000) {
          return false;
        }

        if (!cutoffMs) {
          return true;
        }

        const startedAt = snapshotStartedAtFromName(snapshot.name);
        const startedMs = startedAt ? new Date(startedAt).getTime() : 0;
        const comparableMs = Math.max(startedMs || 0, snapshot.modifiedMs || 0);

        return comparableMs >= cutoffMs;
      })
      .map((snapshot) => this.snapshotAnalysisSource(device, snapshot));
  }

  latestSnapshotSource(deviceKey) {
    return this.finalizedSnapshotSources(deviceKey).at(-1) || null;
  }

  analysisSourcesForDevice(deviceKey, options = {}) {
    if (options.mode === 'latest') {
      const source = this.latestSnapshotSource(deviceKey);
      return source ? [source] : [];
    }

    return this.finalizedSnapshotSources(deviceKey, {
      minutes: options.minutes
    });
  }

  captureCheckpoint(deviceKey, options = {}) {
    const device = this.deviceByKey(deviceKey);
    try {
      this.assertDeviceCanCapture(device);
    } catch (error) {
      this.audit('checkpoint-capture-attempt', {
        deviceKey,
        result: 'blocked',
        error: error.message
      });
      throw error;
    }
    const normalized = normalizeConfig({
      ...this.config,
      casesDir: options.casesDir || this.config.casesDir
    });
    const profile = profileForDevice(normalized, device);
    const durationSeconds = Math.min(Math.max(Number.parseInt(options.durationSeconds, 10) || 60, 5), 86400);
    const startedAt = new Date();
    const timestamp = snapshotTimestamp(startedAt);
    const checkpointDir = path.join(normalized.casesDir, 'checkpoints', slugify(profile.folderName || profile.targetName || device.displayName));
    const outputPath = path.join(checkpointDir, `${slugify(profile.targetName || device.displayName)}-checkpoint-${timestamp}.m4a`);
    const args = buildCheckpointFfmpegArgs(device, outputPath, normalized, durationSeconds);
    let spawnCommand;

    try {
      spawnCommand = ffmpegSpawnCommand(device, args, normalized);
    } catch (error) {
      this.audit('checkpoint-capture-complete', {
        deviceKey,
        deviceName: device.displayName || device.name,
        outputPath,
        result: 'error',
        error: error.message
      });
      throw error;
    }

    this.audit('checkpoint-capture-attempt', {
      deviceKey,
      deviceName: device.displayName || device.name,
      durationSeconds,
      outputPath,
      result: 'started'
    });

    fs.mkdirSync(checkpointDir, { recursive: true });

    return new Promise((resolve, reject) => {
      const child = spawn(spawnCommand.command, spawnCommand.args, {
        stdio: ['ignore', 'ignore', 'pipe']
      });
      let stderr = '';

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', (error) => {
        this.audit('checkpoint-capture-complete', {
          deviceKey,
          deviceName: device.displayName || device.name,
          outputPath,
          result: 'error',
          error: error.message
        });
        reject(error);
      });
      child.on('exit', (code) => {
        if (code !== 0) {
          const error = `Checkpoint capture failed for ${device.displayName}: ${stderr.split(/\r?\n/).slice(-6).join(' ')}`;
          this.audit('checkpoint-capture-complete', {
            deviceKey,
            deviceName: device.displayName || device.name,
            outputPath,
            result: 'error',
            error
          });
          reject(new Error(error));
          return;
        }

        const stat = fs.existsSync(outputPath) ? fs.statSync(outputPath) : null;
        if (!stat || stat.size === 0) {
          const error = `Checkpoint capture created no audio for ${device.displayName}.`;
          this.audit('checkpoint-capture-complete', {
            deviceKey,
            deviceName: device.displayName || device.name,
            outputPath,
            result: 'error',
            error
          });
          reject(new Error(error));
          return;
        }

        this.audit('checkpoint-capture-complete', {
          deviceKey,
          deviceName: device.displayName || device.name,
          outputPath,
          result: 'complete',
          bytes: stat.size,
          durationSeconds
        });
        resolve({
          path: outputPath,
          label: `${profile.targetName || device.displayName} checkpoint ${timestamp}`,
          relativePath: path.relative(normalized.casesDir, outputPath),
          sourceType: 'stream-checkpoint',
          recordingStartedAt: startedAt.toISOString(),
          device: {
            key: device.key,
            name: device.name,
            displayName: device.displayName,
            index: device.index,
            targetName: profile.targetName,
            folderName: profile.folderName
          },
          checkpoint: {
            durationSeconds,
            bytes: stat.size,
            createdAt: new Date().toISOString()
          }
        });
      });
    });
  }

  startAll() {
    const devices = this.targetDevices();
    const attemptDetails = {
      requestedTargetCount: this.devices.filter((device) => device.captureEnabled).length,
      runningCount: this.getStatus().runningCount,
      devices: this.devices.map((device) => ({
        key: device.key,
        displayName: device.displayName || device.name,
        captureEnabled: device.captureEnabled,
        allowed: device.security?.allowed || false,
        blockReason: device.security?.allowed ? null : device.security?.reason
      }))
    };

    if (!devices.length) {
      const blockedInputs = this.devices
        .filter((device) => device.security && !device.security.allowed)
        .map((device) => `${device.displayName || device.name}: ${device.security.detail}`)
        .join('; ');
      const availableInputs = this.devices
        .map((device) => device.displayName || device.name)
        .filter(Boolean)
        .join(', ');
      this.lastError = blockedInputs
        ? `No USB microphone inputs are allowed by the device policy. Blocked inputs: ${blockedInputs}`
        : availableInputs
        ? `No enabled audio inputs were found. macOS currently exposes: ${availableInputs}. Enable "Record this input" for the mic you want, then start recording.`
        : 'No enabled audio inputs were found. macOS is not exposing any audio inputs.';
      this.audit('recording-start-all-attempt', {
        ...attemptDetails,
        result: 'blocked',
        error: this.lastError
      }, {
        dedupeKey: `recording-start-all-blocked:${this.lastError}`,
        minIntervalMs: 60000
      });
      this.emitStatus();
      return this.getStatus();
    }

    this.lastError = null;
    this.audit('recording-start-all-attempt', {
      ...attemptDetails,
      result: 'starting',
      targetDeviceKeys: devices.map((device) => device.key)
    }, {
      dedupeKey: `recording-start-all-starting:${devices.map((device) => device.key).join(',')}`,
      minIntervalMs: 60000
    });

    for (const device of devices) {
      this.startDevice(device.key, false);
    }

    this.emitStatus();
    return this.getStatus();
  }

  assertDeviceCanCapture(device) {
    if (!device.security?.allowed) {
      throw new Error(deviceSecurityError(device));
    }

    if (!device.captureEnabled) {
      throw new Error(`${device.displayName || device.name} is not enabled for recording. Enable it in SoundBite and save setup before capture.`);
    }
  }

  startDevice(deviceKey, shouldRefresh = true) {
    const devices = shouldRefresh ? this.refreshDevices() : this.devices;
    const device = devices.find((candidate) => candidate.key === deviceKey);

    if (!device) {
      this.lastError = `Audio input ${deviceKey} was not found.`;
      this.emitStatus();
      return this.getStatus();
    }

    try {
      this.assertDeviceCanCapture(device);
    } catch (error) {
      this.lastError = error.message;
      this.audit('recording-start-device-attempt', {
        deviceKey,
        deviceName: device.displayName || device.name,
        result: 'blocked',
        error: error.message
      });
      this.emitStatus();
      return this.getStatus();
    }

    const session = this.ensureSession(device);

    try {
      session.start();
      this.lastError = null;
      this.audit('recording-start-device-attempt', {
        deviceKey,
        deviceName: device.displayName || device.name,
        result: 'started',
        pid: session.child?.pid || null
      });
    } catch (error) {
      this.lastError = error.message;
      this.audit('recording-start-device-attempt', {
        deviceKey,
        deviceName: device.displayName || device.name,
        result: 'error',
        error: error.message
      });
    }

    this.emitStatus();
    return this.getStatus();
  }

  stopDevice(deviceKey) {
    const session = this.sessions.get(deviceKey);

    if (!session) {
      return Promise.resolve(this.getStatus());
    }

    return session.stop().then(() => {
      this.emitStatus();
      return this.getStatus();
    });
  }

  stopAll() {
    return Promise.all([...this.sessions.values()].map((session) => session.stop())).then(() => {
      this.emitStatus();
      return this.getStatus();
    });
  }

  isRunning() {
    return [...this.sessions.values()].some((session) => session.isRunning());
  }

  ensureSession(device) {
    const existing = this.sessions.get(device.key);

    if (existing) {
      existing.updateDevice(device);
      existing.updateConfig(this.config);
      return existing;
    }

    const session = new DeviceRecorder(device, this.config);
    session.on('status', () => this.emitStatus());
    this.sessions.set(device.key, session);
    return session;
  }

  getStatus() {
    const sessions = [...this.sessions.values()].map((session) => session.getStatus());
    const runningCount = sessions.filter((session) => session.running).length;

    return {
      running: runningCount > 0,
      runningCount,
      targetCount: this.devices.filter((device) => device.captureEnabled).length,
      targetDeviceNames: this.config.targetDeviceNames,
      segmentSeconds: this.config.segmentSeconds,
      audioBitrate: this.config.audioBitrate,
      autoRecord: this.config.autoRecord,
      exclusiveAudioAccess: this.config.exclusiveAudioAccess,
      preserveOriginalRecordings: this.config.preserveOriginalRecordings,
      discardSilenceSnapshots: this.config.discardSilenceSnapshots,
      silenceMaxVolumeDb: this.config.silenceMaxVolumeDb,
      snapshotFinalizeGraceSeconds: this.config.snapshotFinalizeGraceSeconds,
      deviceSecurityPolicy: this.config.deviceSecurityPolicy,
      securitySummary: securitySummary(this.devices, this.usbControlDevices),
      auditLogPath: this.auditLogger?.filePath || null,
      recordingsDir: this.config.recordingsDir,
      casesDir: this.config.casesDir,
      micProfiles: this.config.micProfiles,
      devices: this.devices,
      sessions,
      lastError: this.lastError
    };
  }

  emitStatus() {
    this.emit('status', this.getStatus());
  }
}

module.exports = {
  DeviceRecorder,
  RecordingManager,
  annotateAudioDevices,
  buildCheckpointFfmpegArgs,
  buildFfmpegArgs,
  findAudioDevice,
  listAvfoundationAudioDevices,
  listSnapshotFiles,
  latestRecording,
  matchesTargetDevice,
  parseMaxVolume,
  profileForDevice,
  recordingDirForDevice,
  shouldDiscardSnapshot,
  snapshotStartedAtFromName,
  snapshotTimestamp,
  parseAvfoundationDevices
};
