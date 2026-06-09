const { DEFAULT_CONFIG } = require('./config');
const { RecordingManager } = require('./recorder');

const manager = new RecordingManager(DEFAULT_CONFIG);
const audioDevices = manager.listAudioDevices();
const targets = audioDevices.filter((device) => device.captureEnabled);

console.log('SoundBite device check');
console.log(`Targets: ${DEFAULT_CONFIG.targetDeviceNames.join(', ')}`);
console.log(`Recordings: ${DEFAULT_CONFIG.recordingsDir}`);
console.log(`Cases: ${DEFAULT_CONFIG.casesDir}`);
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
    console.log(`${marker} [${device.index}] ${device.profile.targetName} -> ${device.profile.folderName} - ${battery}`);
  }
}

console.log('');
console.log(`Target status: ${targets.length} found`);

if (!targets.length) {
  process.exitCode = 1;
}
