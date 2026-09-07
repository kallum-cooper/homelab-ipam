import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

const RETENTION_MS = 48 * 60 * 60 * 1000;

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('now must be a valid date');
  return date;
}

function validateEntry(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id
    || typeof entry.ip !== 'string' || !entry.ip) {
    throw new TypeError('entries require non-empty id and ip');
  }
  for (const field of ['hostname', 'mac']) {
    if (entry[field] !== undefined && typeof entry[field] !== 'string') {
      throw new TypeError(`${field} must be a string`);
    }
  }
}

function sameEntries(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createStateStore(filePath, options = {}) {
  if (typeof filePath !== 'string' || !filePath) throw new TypeError('filePath is required');
  const retentionMs = options.retentionMs ?? RETENTION_MS;
  if (retentionMs !== RETENTION_MS) throw new RangeError('retention is fixed at 48 hours');
  let state = null;

  function persist(candidate) {
    const directory = dirname(filePath);
    mkdirSync(directory, { recursive: true });
    const temporaryPath = join(directory, `.${basename(filePath)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
      renameSync(temporaryPath, filePath);
    } catch (error) {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
      throw error;
    }
  }

  function load() {
    if (state) return structuredClone(state);
    if (!existsSync(filePath)) {
      state = { entries: [] };
      return structuredClone(state);
    }
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!parsed || !Array.isArray(parsed.entries)) throw new TypeError('invalid state file');
    parsed.entries.forEach(validateEntry);
    state = { entries: parsed.entries.map(entry => ({ ...entry })) };
    return structuredClone(state);
  }

  function snapshot(now) {
    const current = validDate(now);
    load();
    const entries = state.entries.filter((entry) => {
      const lastSeen = validDate(entry.lastSeenAt);
      return current.getTime() - lastSeen.getTime() < RETENTION_MS;
    });
    const candidate = { entries };
    if (!sameEntries(candidate.entries, state.entries)) {
      persist(candidate);
      state = candidate;
    }
    return structuredClone(state);
  }

  function recordScan(entries, now) {
    const current = validDate(now);
    if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
    entries.forEach(validateEntry);
    load();

    const merged = new Map(state.entries.map(entry => [entry.id, { ...entry }]));
    for (const entry of entries) {
      const previous = merged.get(entry.id) ?? {};
      merged.set(entry.id, {
        ...previous,
        ...entry,
        lastSeenAt: current.toISOString(),
      });
    }
    const candidate = {
      entries: [...merged.values()].filter((entry) => (
        current.getTime() - validDate(entry.lastSeenAt).getTime() < RETENTION_MS
      )),
    };
    persist(candidate);
    state = candidate;
    return structuredClone(state);
  }

  return {
    filePath,
    load,
    recordScan,
    snapshot,
  };
}
