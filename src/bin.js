const fs = require('node:fs');
const path = require('node:path');

const COMMON_BIN_DIRS = [
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin'
];

function resolveExecutable(name) {
  const pathEntries = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean);
  const searchDirs = [...new Set([...pathEntries, ...COMMON_BIN_DIRS])];

  for (const dir of searchDirs) {
    const candidate = path.join(dir, name);

    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (_error) {
      // Finder-launched apps often have a tiny PATH, so keep scanning.
    }
  }

  return name;
}

module.exports = {
  resolveExecutable
};
