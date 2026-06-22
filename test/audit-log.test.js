const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAuditLogger } = require('../src/audit-log');

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('writes audit events as JSONL under user data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soundbite-audit-'));
  const logger = createAuditLogger(dir, {
    now: () => new Date('2026-06-12T18:00:00.000Z')
  });

  logger.log('device-probe', {
    reason: 'manual-list',
    devices: [{ name: 'MacBook Pro Microphone', allowed: false }]
  });

  const events = readJsonl(logger.filePath);
  assert.equal(events.length, 1);
  assert.equal(events[0].createdAt, '2026-06-12T18:00:00.000Z');
  assert.equal(events[0].kind, 'device-probe');
  assert.equal(events[0].details.reason, 'manual-list');
});

test('dedupes repeated audit events inside the configured interval', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soundbite-audit-'));
  let nowMs = Date.parse('2026-06-12T18:00:00.000Z');
  const logger = createAuditLogger(dir, {
    now: () => new Date(nowMs)
  });

  logger.log('recording-start-all-attempt', { result: 'blocked' }, {
    dedupeKey: 'blocked:no-usb',
    minIntervalMs: 60000
  });
  nowMs += 30000;
  logger.log('recording-start-all-attempt', { result: 'blocked' }, {
    dedupeKey: 'blocked:no-usb',
    minIntervalMs: 60000
  });
  nowMs += 31000;
  logger.log('recording-start-all-attempt', { result: 'blocked' }, {
    dedupeKey: 'blocked:no-usb',
    minIntervalMs: 60000
  });

  assert.equal(readJsonl(logger.filePath).length, 2);
});
