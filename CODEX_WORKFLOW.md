# SoundBite Codex Workflow

## Start Here

1. Read this file before adding app features, recorder behavior, packaging, or automation.
2. Keep the app durable and referenceable: code belongs in this repo, user recordings belong outside git.
3. Prefer small, direct changes that can be verified with `npm test`, `npm run doctor`, and a short recorder smoke test.
4. For a new laptop or fresh clone, use `NEW_LAPTOP_HANDOFF.md` before changing code.

## Current App Shape

- Desktop shell: Electron.
- Recorder engine: local `ffmpeg` using macOS AVFoundation audio input.
- Default target device: `USBAudio1.0`.
- Device policy: only macOS-verified USB audio inputs can be selected or recorded; built-in, Bluetooth, virtual, and unknown-transport inputs are blocked.
- Control policy: SoundBite denies renderer USB/HID/serial/display-capture permissions. USB audio inputs remain recordable even when the same physical mic exposes headset/HID controls.
- Exclusive access: optional/experimental. When enabled, each recorder starts through the macOS Core Audio hog-mode wrapper so selected USB mics are best-effort locked to the recording `ffmpeg` process.
- Device audit log: probe results, blocked/allowed device decisions, recording/checkpoint attempts, and denied Electron device permissions are appended as JSONL under app user data at `audit/device-events.jsonl`.
- Default recordings folder: `~/Documents/SoundBite Recordings`.
- Default forensic cases folder: `~/Documents/SoundBite Cases`.
- Segmenting: one `.m4a` snapshot per 30 minutes by default.
- Mic setup: each detected AVFoundation audio input gets a persisted profile with editable capture, target name, and folder name.
- Original preservation: finalized snapshots are retained by default, including silence-only snapshots.
- Optional silence cleanup: deletion of silence-only snapshots requires explicitly disabling original preservation and writes a JSON record under the mic folder's `discarded-snapshots`.
- Stream analysis: each mic can analyze its latest finalized snapshot, finalized snapshots from a last-N-minutes window, or a live checkpoint capture without stopping the main recorder.
- UI state: recorder status is authoritative for visible mics so partial startup failures do not leave blank controls while recording is active.
- UI grouping: selected recording devices are shown separately from other audio inputs macOS exposes.
- UI layout: tabbed shell with Mics, History, Analysis & Cases, Monitor, and Settings views based on `mockups/soundbite-redesign-mock.html`.
- Session reconciliation: if macOS renumbers or removes an AVFoundation input, stale recorder sessions are stopped instead of counted as active.
- Forensic source: read-only Voice Memos files under `~/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings`.
- Forensic clips: derived files with JSON sidecars and a case `manifest.json`.

## Verification

Run these before claiming a recorder change is done:

```bash
npm test
npm run doctor
```

For packaging changes, also run:

```bash
npm run package:mac
```

For behavior changes, run a short live capture against the USB mic and confirm that a new `.m4a` file appears and grows in the recordings folder.

## Risk Notes

- Do not claim the retail brand of the USB device from software alone. USB IDs and names can be spoofed.
- Do not broaden capture to every microphone unless Caleb explicitly asks. Default to the known USB device.
- Do not weaken the USB-only device policy by trusting display names alone. Unknown transport is blocked unless there is a deliberate, reviewed policy change.
- SoundBite can refuse to record from non-USB audio inputs, deny Electron device permissions, and request Core Audio hog mode for selected mics. It cannot password-protect generic USB hardware or stop macOS itself from accepting HID input from a physically connected USB device. Use OS settings, hardware data blockers, or hardware with native pairing/encryption for that boundary.
- Core Audio hog mode is best-effort and device/driver dependent. The current Jieli `USBAudio1.0` receiver reports hog mode as still unowned after a lock attempt, so do not enable this by default for that device unless the driver behavior changes.
- Do not remove the device audit log when changing probe or permission behavior. It is the durable record for suspicious connection attempts and policy denials.
- Do not modify Voice Memos originals or Apple databases. Treat them as read-only evidence sources.
- Do not describe silence/activity clips as semantically important unless a later transcription or human review supports it.
- Preserve source hashes, relative offsets, and recording start timestamps for every derived clip.
- Do not silently delete original snapshots. If cleanup is explicitly configured to discard a silence-only snapshot, preserve the discard decision as JSON metadata.
- Do not treat the still-open `.m4a` segment as finalized evidence. Use finalized snapshots or a live checkpoint source.
- Live checkpoints may fail if a mic/driver does not allow two simultaneous capture clients.
- Avoid hidden recording behavior. The app should make recording state visible and controllable.
- Battery telemetry is device-dependent. If macOS does not expose battery percentage, report that directly.
- Recording may require macOS microphone permissions for Electron, Terminal, or ffmpeg depending on how it is launched.
- Packaged app launch requests microphone permission before auto-recording; direct terminal launch can still behave differently because macOS permissions are app-identity dependent.
- Recording conversations can carry legal consent risk. Surface that risk plainly when changing recording behavior.
