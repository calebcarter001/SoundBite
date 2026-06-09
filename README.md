# SoundBite

SoundBite is a local desktop app for managing continuous recording from the known USB audio input `USBAudio1.0`.

## Run

```bash
npm install
npm start
```

## Package The Mac App

```bash
npm run package:mac
npm run open:mac
```

The packaged app is written to `dist/SoundBite-darwin-x64/SoundBite.app`.

## Check Device Detection

```bash
npm run doctor
```

## Defaults

- Target input: `USBAudio1.0`
- Recordings folder: `~/Documents/SoundBite Recordings`
- Forensic cases folder: `~/Documents/SoundBite Cases`
- File format: 30-minute `.m4a` snapshots
- Auto-record: on when the target device is connected and the app is running
- Per-mic analysis: latest finalized snapshot, last-N-minutes finalized snapshots, or a live checkpoint capture

## Risk Analysis

- This app makes the USB microphone active by recording it. macOS does not provide a clean public trigger for "record only when another app turns on this exact mic."
- The exact retail device brand cannot be trusted from software alone because USB names and IDs can be spoofed.
- Forensic clip detection starts as audio-activity detection, not semantic truth. It can find candidate moments; it cannot prove a segment is important without review or transcription.
- Derived clips are not originals. Use the JSON sidecars and manifest to tie clips back to source hashes and source offsets.
- Battery life is only shown when macOS exposes a battery property for the device. The current Jieli USB audio interface exposes HID headset controls but no battery percentage.
- Silence-only recorder snapshots are discarded by default after a `volumedetect` pass writes a JSON record under `discarded-snapshots`.
- The still-open `.m4a` file is not treated as finalized evidence. Use a checkpoint if you need current audio before the next 30-minute segment closes.
- Live checkpoints run a second short capture against the same mic. Some hardware or macOS permission states may reject that while the main recorder is active.
- Continuous recording creates consent, storage, battery, and privacy risk. Use it only where you have a lawful basis.
- If macOS microphone permission is denied, the app can appear configured correctly while ffmpeg fails to capture.
