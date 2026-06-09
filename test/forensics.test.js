const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildActivitySegments,
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
