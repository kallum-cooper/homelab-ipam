import { execFile } from 'node:child_process';

function normalizeRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('scanner records must be objects');
  }

  const entry = {};
  for (const field of ['id', 'ip']) {
    if (typeof record[field] !== 'string' || !record[field].trim()) {
      throw new TypeError(`scanner records require a non-empty ${field}`);
    }
    entry[field] = record[field].trim();
  }
  for (const field of ['hostname', 'mac']) {
    if (record[field] === undefined) continue;
    if (typeof record[field] !== 'string' || !record[field].trim()) {
      throw new TypeError(`${field} must be a non-empty string`);
    }
    entry[field] = record[field].trim();
  }
  if (entry.mac) entry.mac = entry.mac.toLowerCase();
  return entry;
}

function parseOutputLine(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith('{')) return normalizeRecord(JSON.parse(trimmed));
  const match = trimmed.match(/^(\d{1,3}(?:\.\d{1,3}){3})\s+((?:[0-9a-f]{2}:){5}[0-9a-f]{2})(?:\s|$)/iu);
  if (!match) return null;
  const mac = match[2].toLowerCase();
  return normalizeRecord({ id: `mac-${mac}`, ip: match[1], mac });
}

export function scanNetwork({ command, args = [], timeoutMs, exec = execFile }) {
  if (typeof command !== 'string' || !command) throw new TypeError('command is required');
  if (!Array.isArray(args) || args.some(argument => typeof argument !== 'string')) {
    throw new TypeError('args must be an array of strings');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be positive');
  }
  if (typeof exec !== 'function') throw new TypeError('exec must be a function');

  return new Promise((resolve, reject) => {
    exec(command, args, { timeout: timeoutMs }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      try {
        const entries = String(stdout)
          .split(/\r?\n/)
          .filter(line => line.trim())
          .map(parseOutputLine)
          .filter(Boolean);
        resolve(entries);
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}
