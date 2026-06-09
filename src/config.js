const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_CONFIG = Object.freeze({
  targetDeviceName: 'USBAudio1.0',
  targetDeviceNames: ['USBAudio1.0'],
  recordingsDir: path.join(os.homedir(), 'Documents', 'SoundBite Recordings'),
  casesDir: path.join(os.homedir(), 'Documents', 'SoundBite Cases'),
  segmentSeconds: 1800,
  audioBitrate: '128k',
  autoRecord: true,
  discardSilenceSnapshots: true,
  silenceMaxVolumeDb: -45,
  snapshotFinalizeGraceSeconds: 90,
  micProfiles: {}
});

function configPath(userDataPath) {
  return path.join(userDataPath, 'config.json');
}

function slugify(value) {
  const slug = String(value || 'device')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || 'device';
}

function profileKeyForDevice(device) {
  return String(device?.key || '');
}

function defaultMicProfile(device, config = DEFAULT_CONFIG) {
  const key = profileKeyForDevice(device);
  const displayName = String(device?.displayName || device?.name || key || 'Audio Input');
  const name = String(device?.name || displayName);
  const targetNames = Array.isArray(config.targetDeviceNames)
    ? config.targetDeviceNames
    : DEFAULT_CONFIG.targetDeviceNames;
  const lowerName = name.toLowerCase();
  const enabled = targetNames.some((targetName) => {
    const target = String(targetName || '').toLowerCase();
    return target && (lowerName === target || lowerName.includes(target));
  });

  return {
    key,
    enabled,
    targetName: displayName,
    folderName: `${slugify(displayName)}-index-${device?.index ?? 'unknown'}`
  };
}

function normalizeMicProfile(profile = {}, fallbackKey = '') {
  const key = String(profile.key || fallbackKey || '').trim();
  const targetName = String(profile.targetName || profile.label || key || 'Audio Input').trim();
  const folderName = slugify(profile.folderName || targetName || key);

  return {
    key,
    enabled: Boolean(profile.enabled),
    targetName,
    folderName
  };
}

function normalizeMicProfiles(input = {}) {
  const profiles = {};

  for (const [key, profile] of Object.entries(input || {})) {
    const normalized = normalizeMicProfile(profile, key);
    if (normalized.key) {
      profiles[normalized.key] = normalized;
    }
  }

  return profiles;
}

function ensureMicProfilesForDevices(config, devices = []) {
  const normalized = normalizeConfig(config);
  let changed = false;

  for (const device of devices) {
    const key = profileKeyForDevice(device);
    if (!key || normalized.micProfiles[key]) {
      continue;
    }

    normalized.micProfiles[key] = defaultMicProfile(device, normalized);
    changed = true;
  }

  return {
    config: normalized,
    changed
  };
}

function normalizeConfig(input = {}) {
  const merged = { ...DEFAULT_CONFIG, ...input };
  const segmentSeconds = Number.parseInt(merged.segmentSeconds, 10);
  const silenceMaxVolumeDb = Number.parseFloat(merged.silenceMaxVolumeDb);
  const snapshotFinalizeGraceSeconds = Number.parseInt(merged.snapshotFinalizeGraceSeconds, 10);
  const targetDeviceNames = Array.isArray(merged.targetDeviceNames)
    ? merged.targetDeviceNames
    : [merged.targetDeviceName || DEFAULT_CONFIG.targetDeviceName];
  const normalizedTargetNames = targetDeviceNames
    .map((name) => String(name || '').trim())
    .filter(Boolean);

  return {
    targetDeviceName: normalizedTargetNames[0] || DEFAULT_CONFIG.targetDeviceName,
    targetDeviceNames: normalizedTargetNames.length ? normalizedTargetNames : [...DEFAULT_CONFIG.targetDeviceNames],
    recordingsDir: path.resolve(String(merged.recordingsDir || DEFAULT_CONFIG.recordingsDir)),
    casesDir: path.resolve(String(merged.casesDir || DEFAULT_CONFIG.casesDir)),
    segmentSeconds: Number.isFinite(segmentSeconds)
      ? Math.min(Math.max(segmentSeconds, 60), 86400)
      : DEFAULT_CONFIG.segmentSeconds,
    audioBitrate: String(merged.audioBitrate || DEFAULT_CONFIG.audioBitrate).trim(),
    autoRecord: Boolean(merged.autoRecord),
    discardSilenceSnapshots: merged.discardSilenceSnapshots !== false,
    silenceMaxVolumeDb: Number.isFinite(silenceMaxVolumeDb)
      ? Math.min(Math.max(silenceMaxVolumeDb, -100), 0)
      : DEFAULT_CONFIG.silenceMaxVolumeDb,
    snapshotFinalizeGraceSeconds: Number.isFinite(snapshotFinalizeGraceSeconds)
      ? Math.min(Math.max(snapshotFinalizeGraceSeconds, 10), 3600)
      : DEFAULT_CONFIG.snapshotFinalizeGraceSeconds,
    micProfiles: normalizeMicProfiles(merged.micProfiles)
  };
}

function loadConfig(userDataPath) {
  const filePath = configPath(userDataPath);

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return normalizeConfig(JSON.parse(raw));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Failed to read config at ${filePath}: ${error.message}`);
    }

    return normalizeConfig();
  }
}

function saveConfig(userDataPath, config) {
  const normalized = normalizeConfig(config);
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(configPath(userDataPath), `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

module.exports = {
  DEFAULT_CONFIG,
  configPath,
  defaultMicProfile,
  ensureMicProfilesForDevices,
  loadConfig,
  normalizeConfig,
  normalizeMicProfile,
  profileKeyForDevice,
  saveConfig
};
