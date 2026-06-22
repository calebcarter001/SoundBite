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
- Device policy: only macOS-verified USB audio inputs can be selected or recorded
- Blocked inputs: built-in, Bluetooth, virtual, and unknown-transport inputs
- Device audit log: `~/Library/Application Support/soundbite/audit/device-events.jsonl`
- Recordings folder: `~/Documents/SoundBite Recordings`
- Forensic cases folder: `~/Documents/SoundBite Cases`
- File format: 30-minute `.m4a` snapshots
- Auto-record: on when the target device is connected and the app is running
- Exclusive audio lock: optional/experimental; selected USB mics can be opened through a Core Audio hog-mode wrapper before recording when the driver supports it
- Per-mic analysis: latest finalized snapshot, last-N-minutes finalized snapshots, or a live checkpoint capture
- App layout: Mics, History, Analysis & Cases, Monitor, and Settings tabs

## Risk Analysis

- This app makes the USB microphone active by recording it. macOS does not provide a clean public trigger for "record only when another app turns on this exact mic."
- The exact retail device brand cannot be trusted from software alone because USB names and IDs can be spoofed.
- SoundBite blocks non-USB audio inputs and denies Electron renderer USB/HID/serial/display-capture permissions. USB wireless/composite mics can still record audio; app-level device-control requests stay denied.
- When exclusive locking is enabled, SoundBite requests Core Audio hog mode for selected mics so other Core Audio clients should not be able to open the same audio device. This is best-effort and depends on the macOS driver exposing hog mode correctly.
- The audit log records what SoundBite sees and denies. It is not a complete macOS USB attach log; use macOS unified logs or router/EDR tooling if you need OS-wide device forensics.
- For the "no computer control" requirement, SoundBite blocks app-level device-control permissions. That does not stop macOS itself from accepting keyboard, mouse, consumer-control, or other HID events from a physical USB device outside SoundBite; use OS settings or hardware data blockers for that boundary if needed.
- Generic USB mics cannot be password-protected by SoundBite at the hardware level. Real device-level password protection requires hardware/firmware support such as native pairing, encryption, or vendor access control.
- The current Jieli `USBAudio1.0` receiver does not accept Core Audio hog mode in local testing; SoundBite leaves exclusive locking off by default so recording still works.
- Forensic clip detection starts as audio-activity detection, not semantic truth. It can find candidate moments; it cannot prove a segment is important without review or transcription.
- Derived clips are not originals. Use the JSON sidecars and manifest to tie clips back to source hashes and source offsets.
- Battery life is only shown when macOS exposes a battery property for the device. The current Jieli USB audio interface exposes HID headset controls but no battery percentage.
- Original recorder snapshots are preserved by default, including silence-only snapshots.
- Optional deletion of silence-only snapshots requires explicitly turning off original preservation; when enabled, the app writes a JSON record under `discarded-snapshots`.
- The still-open `.m4a` file is not treated as finalized evidence. Use a checkpoint if you need current audio before the next 30-minute segment closes.
- Live checkpoints run a second short capture against the same mic. Some hardware or macOS permission states may reject that while the main recorder is active.
- Continuous recording creates consent, storage, battery, and privacy risk. Use it only where you have a lawful basis.
- If macOS microphone permission is denied, the app can appear configured correctly while ffmpeg fails to capture.
- The packaged app requests microphone access before auto-recording. macOS permissions are app-identity dependent, so moving or rebuilding the app can require permission review.
