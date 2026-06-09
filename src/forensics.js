const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { resolveExecutable } = require('./bin');

const VOICE_MEMOS_ROOT = path.join(
  os.homedir(),
  'Library',
  'Group Containers',
  'group.com.apple.VoiceMemos.shared',
  'Recordings'
);

const DEFAULT_CASES_DIR = path.join(os.homedir(), 'Documents', 'SoundBite Cases');

function slugify(value) {
  return String(value || 'recording')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'recording';
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveExecutable(command), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(`${command} exited with code ${code}`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function parseAppleDate(value) {
  const date = new Date(`${value.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function listVoiceMemos(limit = 100) {
  if (!fs.existsSync(VOICE_MEMOS_ROOT)) {
    return [];
  }

  const dbPath = path.join(VOICE_MEMOS_ROOT, 'CloudRecordings.db');
  const query = [
    'select',
    'coalesce(ZCUSTOMLABEL, ZENCRYPTEDTITLE, ZPATH) as label,',
    'ZPATH as path,',
    'ZDURATION as duration,',
    "datetime(ZDATE + 978307200, 'unixepoch') as createdUtc",
    'from ZCLOUDRECORDING',
    'where ZPATH is not null',
    'order by ZDATE desc',
    `limit ${Number.parseInt(limit, 10) || 100};`
  ].join(' ');

  if (fs.existsSync(dbPath)) {
    const result = spawnSync(resolveExecutable('sqlite3'), ['-json', dbPath, query], { encoding: 'utf8' });

    if (!result.error && result.status === 0) {
      return JSON.parse(result.stdout || '[]').map((row) => {
        const filePath = path.join(VOICE_MEMOS_ROOT, row.path);
        const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;

        return {
          label: row.label || row.path,
          path: filePath,
          relativePath: row.path,
          duration: row.duration,
          createdAt: parseAppleDate(row.createdUtc),
          modifiedAt: stat?.mtime.toISOString() || null,
          bytes: stat?.size || 0,
          exists: Boolean(stat)
        };
      });
    }
  }

  try {
    return fs.readdirSync(VOICE_MEMOS_ROOT)
      .filter((name) => /\.(m4a|qta|caf)$/i.test(name))
      .map((name) => {
        const filePath = path.join(VOICE_MEMOS_ROOT, name);
        const stat = fs.statSync(filePath);

        return {
          label: name,
          path: filePath,
          relativePath: name,
          duration: null,
          createdAt: stat.birthtime.toISOString(),
          modifiedAt: stat.mtime.toISOString(),
          bytes: stat.size,
          exists: true
        };
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);
  } catch (error) {
    console.warn(`Failed to list Voice Memos: ${error.message}`);
    return [];
  }
}

function resolveVoiceMemoPath(inputPath) {
  const absolutePath = path.resolve(inputPath);

  if (!isInside(VOICE_MEMOS_ROOT, absolutePath)) {
    throw new Error('Voice Memo path is outside the read-only Voice Memos recordings folder.');
  }

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Voice Memo file does not exist: ${absolutePath}`);
  }

  return absolutePath;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);

    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function probeAudio(filePath) {
  const result = spawnSync(resolveExecutable('ffprobe'), [
    '-v',
    'error',
    '-show_entries',
    'format=duration,format_name:format_tags=creation_time,title',
    '-of',
    'json',
    filePath
  ], { encoding: 'utf8' });

  if (result.status !== 0) {
    throw new Error(result.stderr || 'ffprobe failed.');
  }

  const data = JSON.parse(result.stdout);
  return {
    duration: Number.parseFloat(data.format?.duration || '0'),
    formatName: data.format?.format_name || null,
    title: data.format?.tags?.title || null,
    creationTime: data.format?.tags?.creation_time || null
  };
}

function parseSilenceEvents(stderr) {
  const events = [];
  const startPattern = /silence_start:\s*([0-9.]+)/g;
  const endPattern = /silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/g;

  for (const match of stderr.matchAll(startPattern)) {
    events.push({ type: 'start', at: Number.parseFloat(match[1]) });
  }

  for (const match of stderr.matchAll(endPattern)) {
    events.push({
      type: 'end',
      at: Number.parseFloat(match[1]),
      duration: Number.parseFloat(match[2])
    });
  }

  return events.sort((a, b) => a.at - b.at);
}

function buildActivitySegments(events, duration, options = {}) {
  const minSegmentSeconds = options.minSegmentSeconds ?? 2;
  const paddingSeconds = options.paddingSeconds ?? 1;
  const mergeGapSeconds = options.mergeGapSeconds ?? 2;
  const rawSegments = [];
  let activityStart = 0;
  let inSilence = false;

  for (const event of events) {
    if (event.type === 'start' && !inSilence) {
      if (event.at > activityStart) {
        rawSegments.push({ start: activityStart, end: event.at });
      }
      inSilence = true;
    } else if (event.type === 'end') {
      activityStart = event.at;
      inSilence = false;
    }
  }

  if (!inSilence && duration > activityStart) {
    rawSegments.push({ start: activityStart, end: duration });
  }

  const padded = rawSegments
    .map((segment) => ({
      start: Math.max(0, segment.start - paddingSeconds),
      end: Math.min(duration, segment.end + paddingSeconds)
    }))
    .filter((segment) => segment.end - segment.start >= minSegmentSeconds)
    .sort((a, b) => a.start - b.start);

  const merged = [];
  for (const segment of padded) {
    const previous = merged.at(-1);

    if (previous && segment.start - previous.end <= mergeGapSeconds) {
      previous.end = Math.max(previous.end, segment.end);
    } else {
      merged.push({ ...segment });
    }
  }

  return merged.map((segment, index) => ({
    index: index + 1,
    startSeconds: Number(segment.start.toFixed(3)),
    endSeconds: Number(segment.end.toFixed(3)),
    durationSeconds: Number((segment.end - segment.start).toFixed(3)),
    score: Math.min(100, Math.round((segment.end - segment.start) * 2)),
    reason: 'Non-silent audio activity candidate'
  }));
}

async function detectActivitySegments(filePath, probe, options = {}) {
  const noiseFloorDb = options.noiseFloorDb ?? -35;
  const minSilenceSeconds = options.minSilenceSeconds ?? 0.7;
  const result = await run('ffmpeg', [
    '-hide_banner',
    '-nostdin',
    '-i',
    filePath,
    '-map',
    '0:a:0',
    '-af',
    `silencedetect=noise=${noiseFloorDb}dB:d=${minSilenceSeconds}`,
    '-f',
    'null',
    '-'
  ]);
  const events = parseSilenceEvents(result.stderr);

  return {
    algorithm: 'ffmpeg silencedetect',
    noiseFloorDb,
    minSilenceSeconds,
    events,
    segments: buildActivitySegments(events, probe.duration, options)
  };
}

function addSeconds(isoTime, seconds) {
  if (!isoTime) {
    return null;
  }

  const base = new Date(isoTime).getTime();
  if (!Number.isFinite(base)) {
    return null;
  }

  return new Date(base + seconds * 1000).toISOString();
}

async function extractClip(sourcePath, clipPath, segment) {
  await run('ffmpeg', [
    '-hide_banner',
    '-y',
    '-nostdin',
    '-i',
    sourcePath,
    '-ss',
    String(segment.startSeconds),
    '-t',
    String(segment.durationSeconds),
    '-map',
    '0:a:0',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    clipPath
  ]);
}

function resolveExistingAudioPath(inputPath) {
  const absolutePath = path.resolve(inputPath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Audio file does not exist: ${absolutePath}`);
  }

  if (!fs.statSync(absolutePath).isFile()) {
    throw new Error(`Audio source is not a file: ${absolutePath}`);
  }

  return absolutePath;
}

async function buildSourceInfo(source) {
  const sourcePath = resolveExistingAudioPath(source.path);
  const sourceStat = fs.statSync(sourcePath);
  const sourceHash = await sha256File(sourcePath);
  const probe = probeAudio(sourcePath);
  const label = source.label || path.basename(sourcePath, path.extname(sourcePath));
  const recordingStartedAt = source.recordingStartedAt
    || probe.creationTime
    || source.createdAt
    || sourceStat.birthtime.toISOString();

  return {
    label,
    path: sourcePath,
    relativePath: source.relativePath || path.basename(sourcePath),
    sourceType: source.sourceType || 'audio-file',
    device: source.device || null,
    sha256: sourceHash,
    bytes: sourceStat.size,
    fileCreatedAt: sourceStat.birthtime.toISOString(),
    fileModifiedAt: sourceStat.mtime.toISOString(),
    recordingStartedAt,
    durationSeconds: probe.duration,
    formatName: probe.formatName,
    title: probe.title
  };
}

function compactTimestamp(isoTime) {
  if (!isoTime) {
    return 'undated';
  }

  const date = new Date(isoTime);
  if (Number.isNaN(date.getTime())) {
    return 'undated';
  }

  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function caseIdForSources(sources, options = {}) {
  const label = options.caseLabel || sources[0]?.label || 'audio-analysis';

  if (sources.length === 1) {
    return `${slugify(label)}-${sources[0].sha256.slice(0, 8)}`;
  }

  const digest = crypto.createHash('sha256')
    .update(sources.map((source) => source.sha256).join('|'))
    .digest('hex')
    .slice(0, 8);

  return `${slugify(label)}-${compactTimestamp(sources[0]?.recordingStartedAt)}-${digest}`;
}

async function analyzeAudioSources(inputSources, options = {}) {
  const sourceInputs = Array.isArray(inputSources) ? inputSources : [inputSources];
  const sources = [];

  for (const source of sourceInputs.filter(Boolean)) {
    sources.push(await buildSourceInfo(source));
  }

  if (!sources.length) {
    throw new Error('No audio sources were provided for analysis.');
  }

  const caseId = options.caseId || caseIdForSources(sources, options);
  const caseDir = path.join(options.casesDir || DEFAULT_CASES_DIR, caseId);
  const clipsDir = path.join(caseDir, 'clips');
  const analyses = [];

  fs.mkdirSync(clipsDir, { recursive: true });

  const clips = [];
  for (const [sourceIndex, source] of sources.entries()) {
    const probe = {
      duration: source.durationSeconds,
      formatName: source.formatName,
      title: source.title,
      creationTime: source.recordingStartedAt
    };
    const analysis = await detectActivitySegments(source.path, probe, options);
    const analysisSummary = {
      sourceIndex: sourceIndex + 1,
      sourcePath: source.path,
      algorithm: analysis.algorithm,
      noiseFloorDb: analysis.noiseFloorDb,
      minSilenceSeconds: analysis.minSilenceSeconds,
      eventCount: analysis.events.length,
      segmentCount: analysis.segments.length
    };
    analyses.push(analysisSummary);

    for (const segment of analysis.segments) {
      const globalIndex = clips.length + 1;
      const sourcePrefix = sources.length > 1 ? `source-${String(sourceIndex + 1).padStart(2, '0')}-` : '';
      const clipName = `${sourcePrefix}clip-${String(globalIndex).padStart(3, '0')}-${segment.startSeconds.toFixed(3)}s-${segment.endSeconds.toFixed(3)}s.m4a`;
      const clipPath = path.join(clipsDir, clipName);
      await extractClip(source.path, clipPath, segment);

      const clipHash = await sha256File(clipPath);
      const sidecarPath = `${clipPath}.json`;
      const clip = {
        ...segment,
        index: globalIndex,
        sourceIndex: sourceIndex + 1,
        sourceClipIndex: segment.index,
        path: clipPath,
        sha256: clipHash,
        sourcePath: source.path,
        sourceSha256: source.sha256,
        sourceStartAt: addSeconds(source.recordingStartedAt, segment.startSeconds),
        sourceEndAt: addSeconds(source.recordingStartedAt, segment.endSeconds),
        sidecarPath
      };

      fs.writeFileSync(sidecarPath, `${JSON.stringify({
        source,
        clip,
        analysis: {
          algorithm: analysis.algorithm,
          noiseFloorDb: analysis.noiseFloorDb,
          minSilenceSeconds: analysis.minSilenceSeconds
        }
      }, null, 2)}\n`);

      clips.push(clip);
    }
  }

  const manifest = {
    caseId,
    caseDir,
    createdAt: new Date().toISOString(),
    source: sources[0],
    sources,
    analysis: {
      algorithm: analyses[0]?.algorithm || 'ffmpeg silencedetect',
      noiseFloorDb: analyses[0]?.noiseFloorDb ?? options.noiseFloorDb ?? -35,
      minSilenceSeconds: analyses[0]?.minSilenceSeconds ?? options.minSilenceSeconds ?? 0.7,
      eventCount: analyses.reduce((total, analysis) => total + analysis.eventCount, 0),
      segmentCount: analyses.reduce((total, analysis) => total + analysis.segmentCount, 0),
      sources: analyses
    },
    clips
  };

  fs.writeFileSync(path.join(caseDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function analyzeAudioFile(inputPath, options = {}) {
  const sourcePath = resolveExistingAudioPath(inputPath);

  return analyzeAudioSources([{
    path: sourcePath,
    label: options.label || path.basename(sourcePath, path.extname(sourcePath)),
    relativePath: options.relativePath || path.basename(sourcePath),
    sourceType: options.sourceType || 'audio-file',
    recordingStartedAt: options.recordingStartedAt || null,
    device: options.device || null
  }], options);
}

async function analyzeVoiceMemo(inputPath, options = {}) {
  const sourcePath = resolveVoiceMemoPath(inputPath);
  const probe = probeAudio(sourcePath);
  const sourceBase = path.basename(sourcePath, path.extname(sourcePath));
  const sourceStartedAt = probe.creationTime || listVoiceMemos(500)
    .find((memo) => memo.path === sourcePath)?.createdAt || null;

  return analyzeAudioSources([{
    path: sourcePath,
    label: sourceBase,
    relativePath: path.relative(VOICE_MEMOS_ROOT, sourcePath),
    sourceType: 'voice-memo',
    recordingStartedAt: sourceStartedAt
  }], {
    ...options,
    caseLabel: options.caseLabel || sourceBase
  });
}

module.exports = {
  DEFAULT_CASES_DIR,
  VOICE_MEMOS_ROOT,
  analyzeAudioFile,
  analyzeAudioSources,
  analyzeVoiceMemo,
  buildActivitySegments,
  listVoiceMemos,
  parseSilenceEvents,
  probeAudio,
  resolveExistingAudioPath,
  resolveVoiceMemoPath
};
