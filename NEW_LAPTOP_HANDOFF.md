# SoundBite New Laptop Handoff

Use this when continuing SoundBite from a new Mac. This file is for source-code continuity only; private recordings, cases, and local audit logs stay off GitHub unless Caleb explicitly creates a share-safe evidence export.

## Source Of Truth

- Remote repo: `https://github.com/calebcarter001/SoundBite.git`
- Browser link: `https://github.com/calebcarter001/SoundBite`
- Default branch in this checkout: `master`
- Workflow rules: `CODEX_WORKFLOW.md`
- User recordings: `~/Documents/SoundBite Recordings`
- Case outputs: `~/Documents/SoundBite Cases`
- Device audit log: `~/Library/Application Support/soundbite/audit/device-events.jsonl`

## Fresh Clone

```bash
mkdir -p ~/Workspace
cd ~/Workspace
git clone https://github.com/calebcarter001/SoundBite.git
cd SoundBite
git checkout master
```

Install prerequisites:

```bash
node -v
clang --version
ffmpeg -version
npm install
```

If `clang` is missing, install Xcode Command Line Tools with `xcode-select --install`. If `ffmpeg` is missing and Homebrew is available, install it with `brew install ffmpeg`.

## Local Verification

Run the source and device checks before changing behavior:

```bash
npm run build:helper
npm test
npm run doctor
```

For packaged-app verification:

```bash
npm run package:mac
npm run open:mac
```

On first launch, review macOS microphone permission for the packaged SoundBite app. A direct terminal launch and packaged app launch can have different macOS permission state.

## Continue Development

Start each work session from current remote state:

```bash
git pull --ff-only origin master
sed -n '1,240p' CODEX_WORKFLOW.md
npm test
npm run doctor
```

Use `npm start` for development and `npm run package:mac` when validating packaged behavior. For recorder behavior changes, prove more than process startup: confirm a finalized `.m4a` or live checkpoint exists under `~/Documents/SoundBite Recordings` or `~/Documents/SoundBite Cases`, and inspect it with `ffprobe`.

## Commit And Push

Stage only source, docs, tests, and mockups that belong in the repo:

```bash
git status --short
git add .gitignore CODEX_WORKFLOW.md NEW_LAPTOP_HANDOFF.md README.md package.json package-lock.json src test mockups
git diff --cached --stat
npm test
npm run doctor
git commit -m "Document new laptop SoundBite handoff"
git push origin master
```

Do not add `node_modules/`, `dist/`, `out/`, `coverage/`, generated helper binaries, `.m4a`/`.wav`/`.mp3`/`.aac` files, recordings, case folders, or local app-support audit logs.

## Risk Analysis

- GitHub continuity covers source code only. It does not transfer macOS microphone permission, USB device state, recordings, cases, or audit logs.
- macOS AVFoundation device indexes can change across laptops. Trust `npm run doctor` and visible USB policy checks, not stale device numbers.
- USB names and IDs can be spoofed. SoundBite can enforce its local policy, but it cannot prove the retail identity of attached hardware from software alone.
- The Core Audio hog-mode helper is rebuilt locally and is best-effort. Do not treat it as a guaranteed hardware lock.
- Continuous recording has consent, privacy, and storage risk. Keep private audio data out of Git and only export share-safe evidence intentionally.
- A running app is not proof of healthy recording. Use finalized media, checkpoint output, `ffprobe`, and the device audit log before claiming capture is working.
