const os = require('node:os');
const path = require('node:path');
const { createAuditLogger } = require('./audit-log');
const { loadConfig } = require('./config');
const { RecordingManager } = require('./recorder');

function defaultUserDataPath() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'soundbite');
  }

  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'soundbite');
  }

  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'soundbite');
}

const userDataPath = process.env.SOUNDBITE_USER_DATA || defaultUserDataPath();
const config = loadConfig(userDataPath);
const auditLogger = createAuditLogger(userDataPath);
const manager = new RecordingManager(config, { auditLogger });
const audioDevices = manager.listAudioDevices();
const targets = audioDevices.filter((device) => device.captureEnabled);

console.log('SoundBite device check');
console.log(`Targets: ${config.targetDeviceNames.join(', ')}`);
console.log(`Recordings: ${config.recordingsDir}`);
console.log(`Cases: ${config.casesDir}`);
console.log(`Audit log: ${auditLogger.filePath}`);
console.log(`Device policy: USB audio only ${config.deviceSecurityPolicy.allowOnlyUsbMics ? 'on' : 'off'}, USB HID audio rejection ${config.deviceSecurityPolicy.rejectControlCapableUsbDevices ? 'on' : 'off'}`);
console.log(`Exclusive audio lock: ${config.exclusiveAudioAccess ? 'on' : 'off'}`);
console.log('');

if (!audioDevices.length) {
  console.log('No AVFoundation audio inputs were detected.');
  process.exitCode = 1;
} else {
  for (const device of audioDevices) {
    const marker = device.captureEnabled ? '*' : ' ';
    const battery = device.battery?.available
      ? `battery ${device.battery.percent}%`
      : `battery unavailable (${device.battery?.detail || 'not exposed'})`;
    const security = device.security?.allowed
      ? `allowed (${device.security.detail})`
      : `blocked (${device.security?.detail || 'unknown policy result'})`;
    console.log(`${marker} [${device.index}] ${device.profile.targetName} -> ${device.profile.folderName} - ${security} - ${battery}`);
  }
}

console.log('');
console.log(`Target status: ${targets.length} found`);
console.log(`Blocked inputs: ${audioDevices.filter((device) => device.security && !device.security.allowed).length}`);

if (!targets.length) {
  process.exitCode = 1;
}
