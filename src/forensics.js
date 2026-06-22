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

const ASTATS_FIELD_MAP = {
  'Peak level dB': 'peakLevelDb',
  'RMS level dB': 'rmsLevelDb',
  'RMS peak dB': 'rmsPeakDb',
  'RMS through dB': 'rmsTroughDb',
  'Crest factor': 'crestFactor',
  'Entropy': 'entropy',
  'Dynamic range': 'dynamicRangeDb',
  'Zero crossings rate': 'zeroCrossingRate',
  'Mean difference': 'meanDifference',
  'RMS difference': 'rmsDifference',
  'Noise floor dB': 'noiseFloorDb',
  'Flat factor': 'flatFactor'
};

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

function roundedNumber(value, places = 3) {
  return Number.isFinite(value) ? Number(value.toFixed(places)) : null;
}

function parseFeatureNumber(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseAstats(stderr) {
  const stats = {};
  let inOverall = false;

  for (const line of String(stderr || '').split(/\r?\n/)) {
    if (/\]\s*Overall\s*$/.test(line)) {
      inOverall = true;
      continue;
    }

    const match = line.match(/\]\s*([^:]+):\s*(.+)$/);
    if (!match) {
      continue;
    }

    const field = ASTATS_FIELD_MAP[match[1].trim()];
    if (!field) {
      continue;
    }

    const parsed = parseFeatureNumber(match[2]);
    if (parsed === null) {
      continue;
    }

    if (inOverall || stats[field] === undefined) {
      stats[field] = roundedNumber(parsed);
    }
  }

  return stats;
}

function featureBucket(key, label) {
  return { key, label };
}

function bucketRmsLevel(value) {
  if (!Number.isFinite(value)) return featureBucket('unknown-amplitude', 'unknown amplitude');
  if (value <= -55) return featureBucket('very-quiet', 'very quiet amplitude');
  if (value <= -40) return featureBucket('quiet', 'quiet amplitude');
  if (value <= -28) return featureBucket('moderate', 'moderate amplitude');
  if (value <= -18) return featureBucket('loud', 'loud amplitude');
  return featureBucket('hot', 'hot amplitude');
}

function bucketZeroCrossingRate(value) {
  if (!Number.isFinite(value)) return featureBucket('unknown-texture', 'unknown texture');
  if (value < 0.035) return featureBucket('low-texture', 'low texture');
  if (value < 0.085) return featureBucket('mid-texture', 'mid texture');
  return featureBucket('high-texture', 'high texture');
}

function bucketCrestFactor(value) {
  if (!Number.isFinite(value)) return featureBucket('unknown-envelope', 'unknown envelope');
  if (value < 2) return featureBucket('steady-envelope', 'steady envelope');
  if (value < 5) return featureBucket('dynamic-envelope', 'dynamic envelope');
  return featureBucket('spiky-envelope', 'spiky envelope');
}

function bucketDuration(value) {
  if (!Number.isFinite(value)) return featureBucket('unknown-duration', 'unknown duration');
  if (value < 3) return featureBucket('brief', 'brief');
  if (value < 15) return featureBucket('short', 'short');
  if (value < 60) return featureBucket('medium', 'medium');
  return featureBucket('extended', 'extended');
}

function buildAudioFeatureProfile(stats = {}, segment = {}) {
  const rms = parseFeatureNumber(stats.rmsLevelDb);
  const zeroCrossingRate = parseFeatureNumber(stats.zeroCrossingRate);
  const crestFactor = parseFeatureNumber(stats.crestFactor);
  const loudness = bucketRmsLevel(rms);
  const texture = bucketZeroCrossingRate(zeroCrossingRate);
  const dynamics = bucketCrestFactor(crestFactor);
  const duration = bucketDuration(parseFeatureNumber(segment.durationSeconds));

  return {
    algorithm: 'ffmpeg astats',
    featureSignatureVersion: 1,
    featureSignature: [loudness.key, texture.key, dynamics.key].join('|'),
    rmsLevelDb: roundedNumber(rms),
    peakLevelDb: roundedNumber(parseFeatureNumber(stats.peakLevelDb)),
    rmsPeakDb: roundedNumber(parseFeatureNumber(stats.rmsPeakDb)),
    rmsTroughDb: roundedNumber(parseFeatureNumber(stats.rmsTroughDb)),
    crestFactor: roundedNumber(crestFactor),
    entropy: roundedNumber(parseFeatureNumber(stats.entropy)),
    dynamicRangeDb: roundedNumber(parseFeatureNumber(stats.dynamicRangeDb)),
    zeroCrossingRate: roundedNumber(zeroCrossingRate, 6),
    meanDifference: roundedNumber(parseFeatureNumber(stats.meanDifference), 6),
    rmsDifference: roundedNumber(parseFeatureNumber(stats.rmsDifference), 6),
    noiseFloorDb: roundedNumber(parseFeatureNumber(stats.noiseFloorDb)),
    flatFactor: roundedNumber(parseFeatureNumber(stats.flatFactor)),
    labels: {
      loudness: loudness.label,
      texture: texture.label,
      dynamics: dynamics.label,
      duration: duration.label
    },
    groupingFeatures: ['rmsLevelDb', 'zeroCrossingRate', 'crestFactor']
  };
}

async function analyzeClipFeatures(clipPath, segment) {
  const result = await run('ffmpeg', [
    '-hide_banner',
    '-nostdin',
    '-i',
    clipPath,
    '-map',
    '0:a:0',
    '-af',
    'astats=metadata=0:reset=0',
    '-f',
    'null',
    '-'
  ]);

  return buildAudioFeatureProfile(parseAstats(result.stderr), segment);
}

function collectionLabel(features = {}) {
  const labels = features.labels || {};
  return [
    labels.loudness,
    labels.texture,
    labels.dynamics
  ].filter(Boolean).join(', ') || 'unclassified audio feature match';
}

function averageFeatureValue(clips, field, places = 3) {
  const values = clips
    .map((clip) => clip.audioFeatures?.[field])
    .filter(Number.isFinite);

  if (!values.length) {
    return null;
  }

  return roundedNumber(values.reduce((total, value) => total + value, 0) / values.length, places);
}

function buildSimilarityCollections(clips) {
  const groups = new Map();

  for (const clip of clips) {
    const signature = clip.audioFeatures?.featureSignature || 'unknown-amplitude|unknown-texture|unknown-envelope';
    if (!groups.has(signature)) {
      groups.set(signature, []);
    }
    groups.get(signature).push(clip);
  }

  return [...groups.entries()]
    .sort((left, right) => {
      const sizeDelta = right[1].length - left[1].length;
      if (sizeDelta !== 0) {
        return sizeDelta;
      }

      return (left[1][0]?.index || 0) - (right[1][0]?.index || 0);
    })
    .map(([signature, groupClips], index) => {
      const collectionId = `collection-${String(index + 1).padStart(3, '0')}`;

      for (const clip of groupClips) {
        clip.collectionId = collectionId;
      }

      return {
        collectionId,
        label: collectionLabel(groupClips[0]?.audioFeatures),
        reason: 'Grouped by matching coarse buckets for RMS amplitude, zero-crossing texture, and crest-factor envelope.',
        featureSignature: signature,
        clipIndexes: groupClips.map((clip) => clip.index),
        clipCount: groupClips.length,
        totalDurationSeconds: roundedNumber(groupClips.reduce((total, clip) => total + (clip.durationSeconds || 0), 0)),
        averageFeatures: {
          rmsLevelDb: averageFeatureValue(groupClips, 'rmsLevelDb'),
          peakLevelDb: averageFeatureValue(groupClips, 'peakLevelDb'),
          crestFactor: averageFeatureValue(groupClips, 'crestFactor'),
          zeroCrossingRate: averageFeatureValue(groupClips, 'zeroCrossingRate', 6),
          entropy: averageFeatureValue(groupClips, 'entropy')
        },
        sections: groupClips.map((clip) => ({
          clipIndex: clip.index,
          sourceIndex: clip.sourceIndex,
          sourceClipIndex: clip.sourceClipIndex,
          startSeconds: clip.startSeconds,
          endSeconds: clip.endSeconds,
          durationSeconds: clip.durationSeconds,
          sourceStartAt: clip.sourceStartAt,
          sourceEndAt: clip.sourceEndAt,
          score: clip.score,
          path: clip.path,
          sha256: clip.sha256
        }))
      };
    });
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

function reportDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) {
    return 'unknown';
  }

  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remainingSeconds = Math.round(value % 60);
  const parts = [];

  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  parts.push(`${remainingSeconds}s`);
  return parts.join(' ');
}

function reportFeatureValue(value, suffix = '') {
  return Number.isFinite(value) ? `${value}${suffix}` : 'unknown';
}

function buildCaseReportMarkdown(manifest) {
  const lines = [
    '# SoundBite Analysis Report',
    '',
    `Case: ${manifest.caseId}`,
    `Created: ${manifest.createdAt}`,
    `Recording length analyzed: ${reportDuration(manifest.report.recordingDurationSeconds)} (${manifest.report.recordingDurationSeconds}s across ${manifest.sources.length} source(s))`,
    `Notable sections found: ${manifest.report.notableSectionCount} non-silent activity candidate(s)`,
    `Similarity collections: ${manifest.report.collectionCount}`,
    '',
    'Risk note: these are audio activity and coarse feature matches only. They do not prove meaning, speaker identity, or legal relevance without review or transcription.',
    '',
    '## Sources',
    ''
  ];

  for (const source of manifest.sources) {
    lines.push(
      `- Source ${manifest.sources.indexOf(source) + 1}: ${source.label}`,
      `  - Duration: ${reportDuration(source.durationSeconds)} (${source.durationSeconds}s)`,
      `  - SHA-256: ${source.sha256}`,
      `  - Path: ${source.path}`
    );
  }

  lines.push('', '## Similarity Collections', '');

  if (!manifest.similarityCollections.length) {
    lines.push('No non-silent activity clips were isolated for grouping.');
  } else {
    for (const collection of manifest.similarityCollections) {
      lines.push(
        `### ${collection.collectionId}: ${collection.label}`,
        '',
        `- Clips: ${collection.clipIndexes.join(', ')}`,
        `- Total duration: ${reportDuration(collection.totalDurationSeconds)} (${collection.totalDurationSeconds}s)`,
        `- Average RMS amplitude: ${reportFeatureValue(collection.averageFeatures.rmsLevelDb, ' dB')}`,
        `- Average peak: ${reportFeatureValue(collection.averageFeatures.peakLevelDb, ' dB')}`,
        `- Average zero-crossing rate: ${reportFeatureValue(collection.averageFeatures.zeroCrossingRate)}`,
        `- Why grouped: ${collection.reason}`,
        '',
        '| Clip | Source | Offset | Duration | Score | SHA-256 |',
        '| --- | --- | --- | --- | --- | --- |'
      );

      for (const section of collection.sections) {
        lines.push(`| clip-${String(section.clipIndex).padStart(3, '0')} | ${section.sourceIndex} | ${section.startSeconds}s to ${section.endSeconds}s | ${section.durationSeconds}s | ${section.score} | ${section.sha256} |`);
      }

      lines.push('');
    }
  }

  lines.push('## All Notable Sections', '');

  if (!manifest.clips.length) {
    lines.push('No non-silent activity candidates were detected.');
  } else {
    lines.push('| Clip | Collection | Source | Offset | Duration | Features | Clip path |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');

    for (const clip of manifest.clips) {
      const features = clip.audioFeatures?.labels || {};
      const featureLabel = [
        features.loudness,
        features.texture,
        features.dynamics
      ].filter(Boolean).join(', ') || 'unknown features';

      lines.push(`| clip-${String(clip.index).padStart(3, '0')} | ${clip.collectionId || 'unassigned'} | ${clip.sourceIndex} | ${clip.startSeconds}s to ${clip.endSeconds}s | ${clip.durationSeconds}s | ${featureLabel} | ${clip.path} |`);
    }
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
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
  const clipSidecars = [];
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
      let audioFeatures = null;
      try {
        audioFeatures = await analyzeClipFeatures(clipPath, segment);
      } catch (error) {
        audioFeatures = {
          ...buildAudioFeatureProfile({}, segment),
          error: error?.message || 'Audio feature measurement failed'
        };
      }

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
        sidecarPath,
        audioFeatures
      };

      clipSidecars.push({
        source,
        clip,
        analysis: {
          algorithm: analysis.algorithm,
          noiseFloorDb: analysis.noiseFloorDb,
          minSilenceSeconds: analysis.minSilenceSeconds
        }
      });

      clips.push(clip);
    }
  }

  const similarityCollections = buildSimilarityCollections(clips);
  const collectionById = new Map(similarityCollections.map((collection) => [collection.collectionId, collection]));
  const recordingDurationSeconds = roundedNumber(sources.reduce((total, source) => {
    const duration = Number(source.durationSeconds);
    return total + (Number.isFinite(duration) ? duration : 0);
  }, 0));
  const reportMarkdownPath = path.join(caseDir, 'report.md');
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
    grouping: {
      algorithm: 'coarse-audio-feature-buckets',
      features: ['rmsLevelDb', 'zeroCrossingRate', 'crestFactor'],
      collectionCount: similarityCollections.length,
      note: 'Feature buckets are similarity aids only and require human review.'
    },
    report: {
      markdownPath: reportMarkdownPath,
      recordingDurationSeconds,
      notableSectionCount: clips.length,
      collectionCount: similarityCollections.length,
      summary: `Analyzed ${recordingDurationSeconds}s across ${sources.length} source(s), isolated ${clips.length} non-silent activity candidate(s), and grouped them into ${similarityCollections.length} coarse audio-feature collection(s).`
    },
    similarityCollections,
    clips
  };

  for (const sidecar of clipSidecars) {
    fs.writeFileSync(sidecar.clip.sidecarPath, `${JSON.stringify({
      source: sidecar.source,
      clip: sidecar.clip,
      collection: collectionById.get(sidecar.clip.collectionId) || null,
      analysis: sidecar.analysis
    }, null, 2)}\n`);
  }

  fs.writeFileSync(reportMarkdownPath, buildCaseReportMarkdown(manifest));
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
  buildAudioFeatureProfile,
  buildActivitySegments,
  buildSimilarityCollections,
  listVoiceMemos,
  parseAstats,
  parseSilenceEvents,
  probeAudio,
  resolveExistingAudioPath,
  resolveVoiceMemoPath
};
