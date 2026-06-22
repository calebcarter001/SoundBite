const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildAudioFeatureProfile,
  buildActivitySegments,
  buildSimilarityCollections,
  parseAstats,
  parseSilenceEvents
} = require('../src/forensics');

test('parses ffmpeg silencedetect events', () => {
  const events = parseSilenceEvents(`
[silencedetect @ 0x1] silence_start: 3.5
[silencedetect @ 0x1] silence_end: 7.25 | silence_duration: 3.75
[silencedetect @ 0x1] silence_start: 12
`);

  assert.deepEqual(events, [
    { type: 'start', at: 3.5 },
    { type: 'end', at: 7.25, duration: 3.75 },
    { type: 'start', at: 12 }
  ]);
});

test('builds padded activity segments while preserving source offsets', () => {
  const segments = buildActivitySegments(
    [
      { type: 'start', at: 3.5 },
      { type: 'end', at: 7.25, duration: 3.75 },
      { type: 'start', at: 12 }
    ],
    20,
    {
      minSegmentSeconds: 2,
      paddingSeconds: 1,
      mergeGapSeconds: 1
    }
  );

  assert.deepEqual(segments.map((segment) => ({
    startSeconds: segment.startSeconds,
    endSeconds: segment.endSeconds,
    durationSeconds: segment.durationSeconds
  })), [
    { startSeconds: 0, endSeconds: 4.5, durationSeconds: 4.5 },
    { startSeconds: 6.25, endSeconds: 13, durationSeconds: 6.75 }
  ]);
});

test('parses ffmpeg astats output into reusable audio features', () => {
  const stats = parseAstats(`
  [Parsed_astats_0 @ 0x1] Channel: 1
  [Parsed_astats_0 @ 0x1] Peak level dB: -17.725270
  [Parsed_astats_0 @ 0x1] RMS level dB: -21.222904
  [Parsed_astats_0 @ 0x1] Crest factor: 1.495828
  [Parsed_astats_0 @ 0x1] Zero crossings rate: 0.020774
  [Parsed_astats_0 @ 0x1] Overall
  [Parsed_astats_0 @ 0x1] Peak level dB: -18.125
  [Parsed_astats_0 @ 0x1] RMS level dB: -22.5
  [Parsed_astats_0 @ 0x1] Entropy: 0.753290
  `);

  assert.deepEqual(stats, {
    peakLevelDb: -18.125,
    rmsLevelDb: -22.5,
    crestFactor: 1.496,
    zeroCrossingRate: 0.021,
    entropy: 0.753
  });
});

test('builds coarse feature signatures from measured audio stats', () => {
  const profile = buildAudioFeatureProfile({
    rmsLevelDb: -21.2,
    peakLevelDb: -17.7,
    zeroCrossingRate: 0.020774,
    crestFactor: 1.49
  }, { durationSeconds: 4.5 });

  assert.equal(profile.featureSignature, 'loud|low-texture|steady-envelope');
  assert.deepEqual(profile.labels, {
    loudness: 'loud amplitude',
    texture: 'low texture',
    dynamics: 'steady envelope',
    duration: 'short'
  });
  assert.deepEqual(profile.groupingFeatures, ['rmsLevelDb', 'zeroCrossingRate', 'crestFactor']);
});

test('groups clips into similarity collections by matching feature signatures', () => {
  const clips = [
    {
      index: 1,
      sourceIndex: 1,
      sourceClipIndex: 1,
      startSeconds: 0,
      endSeconds: 4,
      durationSeconds: 4,
      score: 8,
      path: '/tmp/clip-001.m4a',
      sha256: 'a',
      audioFeatures: buildAudioFeatureProfile({
        rmsLevelDb: -21,
        peakLevelDb: -17,
        zeroCrossingRate: 0.02,
        crestFactor: 1.4
      }, { durationSeconds: 4 })
    },
    {
      index: 2,
      sourceIndex: 1,
      sourceClipIndex: 2,
      startSeconds: 10,
      endSeconds: 15,
      durationSeconds: 5,
      score: 10,
      path: '/tmp/clip-002.m4a',
      sha256: 'b',
      audioFeatures: buildAudioFeatureProfile({
        rmsLevelDb: -23,
        peakLevelDb: -18,
        zeroCrossingRate: 0.03,
        crestFactor: 1.8
      }, { durationSeconds: 5 })
    },
    {
      index: 3,
      sourceIndex: 1,
      sourceClipIndex: 3,
      startSeconds: 30,
      endSeconds: 35,
      durationSeconds: 5,
      score: 10,
      path: '/tmp/clip-003.m4a',
      sha256: 'c',
      audioFeatures: buildAudioFeatureProfile({
        rmsLevelDb: -45,
        peakLevelDb: -35,
        zeroCrossingRate: 0.12,
        crestFactor: 6
      }, { durationSeconds: 5 })
    }
  ];

  const collections = buildSimilarityCollections(clips);

  assert.equal(collections.length, 2);
  assert.deepEqual(collections[0].clipIndexes, [1, 2]);
  assert.equal(collections[0].collectionId, 'collection-001');
  assert.equal(collections[0].clipCount, 2);
  assert.equal(collections[0].totalDurationSeconds, 9);
  assert.equal(clips[0].collectionId, 'collection-001');
  assert.equal(clips[1].collectionId, 'collection-001');
  assert.equal(clips[2].collectionId, 'collection-002');
});
