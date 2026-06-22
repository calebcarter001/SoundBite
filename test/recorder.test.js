const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const {
  annotateAudioDevices,
  buildCheckpointFfmpegArgs,
  buildFfmpegArgs,
  DeviceRecorder,
  findAudioDevice,
  matchesTargetDevice,
  parseMaxVolume,
  profileForDevice,
  recordingDirForDevice,
  shouldDiscardSnapshot,
  snapshotStartedAtFromName,
  parseAvfoundationDevices
} = require('../src/recorder');
const {
  DEFAULT_CONFIG,
  ensureMicProfilesForDevices,
  normalizeConfig
} = require('../src/config');

const sampleOutput = `
[AVFoundation indev @ 0x7fa4b1a04a80] AVFoundation video devices:
[AVFoundation indev @ 0x7fa4b1a04a80] [0] FaceTime HD Camera (Built-in)
[AVFoundation indev @ 0x7fa4b1a04a80] AVFoundation audio devices:
[AVFoundation indev @ 0x7fa4b1a04a80] [0] MacBook Pro Microphone
[AVFoundation indev @ 0x7fa4b1a04a80] [1] USBAudio1.0
[AVFoundation indev @ 0x7fa4b1a04a80] [2] Caleb's Microphone
`;

test('parses AVFoundation audio and video devices', () => {
  const devices = parseAvfoundationDevices(sampleOutput);

  assert.deepEqual(devices.video, [
    { index: 0, name: 'FaceTime HD Camera (Built-in)' }
  ]);
  assert.deepEqual(devices.audio, [
    { index: 0, name: 'MacBook Pro Microphone' },
    { index: 1, name: 'USBAudio1.0' },
    { index: 2, name: "Caleb's Microphone" }
  ]);
});

test('finds the target audio device by exact case-insensitive name', () => {
  const devices = parseAvfoundationDevices(sampleOutput);
  const device = findAudioDevice(devices, 'usbaudio1.0');

  assert.deepEqual(device, { index: 1, name: 'USBAudio1.0' });
});

test('annotates duplicate audio devices with separate keys and labels', () => {
  const devices = annotateAudioDevices([
    { index: 1, name: 'USBAudio1.0' },
    { index: 2, name: 'USBAudio1.0' }
  ]);

  assert.equal(devices[0].displayName, 'USBAudio1.0 #1');
  assert.equal(devices[1].displayName, 'USBAudio1.0 #2');
  assert.equal(devices[0].key, 'avfoundation-1-usbaudio1-0');
  assert.equal(devices[1].key, 'avfoundation-2-usbaudio1-0');
});

test('matches every audio device with a configured target name', () => {
  const devices = annotateAudioDevices([
    { index: 1, name: 'USBAudio1.0' },
    { index: 2, name: 'USBAudio1.0' },
    { index: 3, name: 'MacBook Pro Microphone' }
  ]);
  const config = ensureMicProfilesForDevices(
    { targetDeviceNames: ['USBAudio1.0'] },
    devices
  ).config;

  assert.equal(matchesTargetDevice(devices[0], config), true);
  assert.equal(matchesTargetDevice(devices[1], config), true);
  assert.equal(matchesTargetDevice(devices[2], config), false);
});

test('defaults to 30-minute snapshots', () => {
  assert.equal(DEFAULT_CONFIG.segmentSeconds, 1800);
  assert.equal(normalizeConfig().segmentSeconds, 1800);
});

test('keeps exclusive audio access opt-in because hog mode is device-dependent', () => {
  assert.equal(DEFAULT_CONFIG.exclusiveAudioAccess, false);
  assert.equal(normalizeConfig().exclusiveAudioAccess, false);
  assert.equal(normalizeConfig({ exclusiveAudioAccess: true }).exclusiveAudioAccess, true);
  assert.equal(normalizeConfig({ exclusiveAudioAccess: false }).exclusiveAudioAccess, false);
});

test('preserves original snapshots by default and migrates old silence deletion configs', () => {
  assert.equal(DEFAULT_CONFIG.preserveOriginalRecordings, true);
  assert.equal(DEFAULT_CONFIG.discardSilenceSnapshots, false);
  assert.equal(normalizeConfig().preserveOriginalRecordings, true);
  assert.equal(normalizeConfig().discardSilenceSnapshots, false);
  assert.equal(normalizeConfig({ discardSilenceSnapshots: true }).discardSilenceSnapshots, false);

  const explicitDeletion = normalizeConfig({
    preserveOriginalRecordings: false,
    discardSilenceSnapshots: true
  });

  assert.equal(explicitDeletion.preserveOriginalRecordings, false);
  assert.equal(explicitDeletion.discardSilenceSnapshots, true);
});

test('auto-creates editable mic profiles for detected devices', () => {
  const devices = annotateAudioDevices([
    { index: 1, name: 'USBAudio1.0' },
    { index: 3, name: 'MacBook Pro Microphone' }
  ]);
  const result = ensureMicProfilesForDevices({ targetDeviceNames: ['USBAudio1.0'] }, devices);
  const usbProfile = result.config.micProfiles[devices[0].key];
  const builtInProfile = result.config.micProfiles[devices[1].key];

  assert.equal(usbProfile.enabled, true);
  assert.equal(usbProfile.targetName, 'USBAudio1.0');
  assert.equal(usbProfile.folderName, 'usbaudio1-0-index-1');
  assert.equal(builtInProfile.enabled, false);
});

test('builds segmented ffmpeg arguments for audio-only capture', () => {
  const args = buildFfmpegArgs(
    { index: 1, name: 'USBAudio1.0', displayName: 'USBAudio1.0', key: 'avfoundation-1-usbaudio1-0' },
    {
      targetDeviceNames: ['USBAudio1.0'],
      micProfiles: {
        'avfoundation-1-usbaudio1-0': {
          key: 'avfoundation-1-usbaudio1-0',
          enabled: true,
          targetName: 'Desk Mic',
          folderName: 'desk-mic'
        }
      },
      recordingsDir: '/tmp/soundbite-test',
      segmentSeconds: 120,
      audioBitrate: '96k',
      autoRecord: true
    }
  );

  assert.equal(args[args.indexOf('-i') + 1], ':1');
  assert.equal(args[args.indexOf('-segment_time') + 1], '120');
  assert.equal(args[args.indexOf('-b:a') + 1], '96k');
  assert.equal(args.at(-1), path.join('/tmp/soundbite-test', 'desk-mic', 'desk-mic-%Y%m%d-%H%M%S.m4a'));
});

test('builds checkpoint ffmpeg arguments without stopping the main recorder', () => {
  const args = buildCheckpointFfmpegArgs(
    { index: 2, name: 'USBAudio1.0', displayName: 'USBAudio1.0 #2', key: 'avfoundation-2-usbaudio1-0' },
    '/tmp/soundbite-checkpoint.m4a',
    { audioBitrate: '96k' },
    45
  );

  assert.equal(args[args.indexOf('-i') + 1], ':2');
  assert.equal(args[args.indexOf('-t') + 1], '45');
  assert.equal(args[args.indexOf('-b:a') + 1], '96k');
  assert.equal(args.at(-1), '/tmp/soundbite-checkpoint.m4a');
});

test('treats a signaled recorder child as running until it exits', () => {
  const recorder = new DeviceRecorder(
    { index: 1, name: 'USBAudio1.0', displayName: 'USBAudio1.0', key: 'avfoundation-1-usbaudio1-0' },
    { recordingsDir: '/tmp/soundbite-test' }
  );

  recorder.child = {
    killed: true,
    exitCode: null,
    signalCode: null,
    pid: 12345
  };

  assert.equal(recorder.isRunning(), true);

  recorder.child.signalCode = 'SIGTERM';

  assert.equal(recorder.isRunning(), false);
});

test('parses snapshot start time from recorder filenames', () => {
  assert.equal(
    snapshotStartedAtFromName('desk-mic-20260608-173000.m4a'),
    new Date(2026, 5, 8, 17, 30, 0).toISOString()
  );
  assert.equal(snapshotStartedAtFromName('desk-mic-current.m4a'), null);
});

test('builds a separate recording directory per current audio input', () => {
  const directory = recordingDirForDevice(
    {
      targetDeviceNames: ['USBAudio1.0'],
      recordingsDir: '/tmp/soundbite-test',
      micProfiles: {
        'avfoundation-2-usbaudio1-0': {
          key: 'avfoundation-2-usbaudio1-0',
          enabled: true,
          targetName: 'Pocket Mic',
          folderName: 'pocket-mic'
        }
      }
    },
    { index: 2, name: 'USBAudio1.0', displayName: 'USBAudio1.0 #2', key: 'avfoundation-2-usbaudio1-0' }
  );

  assert.equal(directory, path.join('/tmp/soundbite-test', 'pocket-mic'));
});

test('resolves profile settings for a device', () => {
  const profile = profileForDevice(
    {
      micProfiles: {
        'avfoundation-7-mic': {
          key: 'avfoundation-7-mic',
          enabled: true,
          targetName: 'Bag Mic',
          folderName: 'bag-mic'
        }
      }
    },
    { key: 'avfoundation-7-mic', name: 'Mic', displayName: 'Mic', index: 7 }
  );

  assert.equal(profile.targetName, 'Bag Mic');
  assert.equal(profile.folderName, 'bag-mic');
});

test('parses max volume and applies silence discard threshold', () => {
  assert.equal(parseMaxVolume('[Parsed_volumedetect_0] max_volume: -46.2 dB'), -46.2);
  assert.equal(parseMaxVolume('[Parsed_volumedetect_0] max_volume: -inf dB'), -Infinity);
  assert.equal(shouldDiscardSnapshot(-46.2, -45), true);
  assert.equal(shouldDiscardSnapshot(-30, -45), false);
  assert.equal(shouldDiscardSnapshot(-Infinity, -45), true);
});
