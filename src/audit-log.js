const fs = require('node:fs');
const path = require('node:path');

function sanitizeForJson(value) {
  if (value === undefined) {
    return null;
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_error) {
    return String(value);
  }
}

class AuditLogger {
  constructor(userDataPath, options = {}) {
    this.filePath = path.join(userDataPath, 'audit', 'device-events.jsonl');
    this.now = options.now || (() => new Date());
    this.dedupe = new Map();
  }

  log(kind, details = {}, options = {}) {
    const createdAt = this.now().toISOString();
    const dedupeKey = options.dedupeKey || '';
    const minIntervalMs = Number.parseInt(options.minIntervalMs, 10) || 0;

    if (dedupeKey && minIntervalMs > 0) {
      const previous = this.dedupe.get(dedupeKey) || 0;
      const current = new Date(createdAt).getTime();

      if (current - previous < minIntervalMs) {
        return null;
      }

      this.dedupe.set(dedupeKey, current);
    }

    const entry = {
      createdAt,
      kind: String(kind || 'event'),
      details: sanitizeForJson(details)
    };

    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`);
      return entry;
    } catch (error) {
      console.warn(`Failed to write SoundBite audit log: ${error.message}`);
      return null;
    }
  }
}

function createAuditLogger(userDataPath, options = {}) {
  return new AuditLogger(userDataPath, options);
}

module.exports = {
  AuditLogger,
  createAuditLogger,
  sanitizeForJson
};
