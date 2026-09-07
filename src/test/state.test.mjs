import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createStateStore } from '../state.mjs';

const hour = 60 * 60 * 1000;

async function storeForTest() {
  const directory = await mkdtemp(join(tmpdir(), 'ipam-state-'));
  return createStateStore(join(directory, 'state.json'));
}

test('loads an empty store when the state file is absent', async () => {
  const store = await storeForTest();

  assert.deepEqual(store.load(), { entries: [] });
});

test('merges repeated sightings and updates their latest fields', async () => {
  const store = await storeForTest();
  const firstSeen = new Date('2026-09-01T10:00:00.000Z');
  const secondSeen = new Date(firstSeen.getTime() + hour);

  store.recordScan([{ id: 'host-1', ip: '192.168.1.10', hostname: 'old-name' }], firstSeen);
  store.recordScan([
    { id: 'host-1', ip: '192.168.1.11', hostname: 'new-name', mac: 'aa:bb:cc:dd:ee:ff' },
    { id: 'host-2', ip: '192.168.1.12' },
  ], secondSeen);

  assert.deepEqual(store.snapshot(secondSeen), {
    entries: [
      {
        id: 'host-1',
        ip: '192.168.1.11',
        hostname: 'new-name',
        mac: 'aa:bb:cc:dd:ee:ff',
        lastSeenAt: secondSeen.toISOString(),
      },
      { id: 'host-2', ip: '192.168.1.12', lastSeenAt: secondSeen.toISOString() },
    ],
  });
});

test('retains an entry when it was last seen less than 48 hours ago', async () => {
  const store = await storeForTest();
  const seenAt = new Date('2026-09-01T00:00:00.000Z');
  const now = new Date(seenAt.getTime() + 48 * hour - 1);

  store.recordScan([{ id: 'host-1', ip: '192.168.1.10' }], seenAt);

  assert.equal(store.snapshot(now).entries.length, 1);
});

test('expires an entry at exactly 48 hours', async () => {
  const store = await storeForTest();
  const seenAt = new Date('2026-09-01T00:00:00.000Z');
  const now = new Date(seenAt.getTime() + 48 * hour);

  store.recordScan([{ id: 'host-1', ip: '192.168.1.10' }], seenAt);

  assert.deepEqual(store.snapshot(now), { entries: [] });
});

test('does not replace prior state when a scan is unsuccessful', async () => {
  const store = await storeForTest();
  const seenAt = new Date('2026-09-01T00:00:00.000Z');
  const before = store.snapshot(seenAt);

  store.recordScan([{ id: 'host-1', ip: '192.168.1.10' }], seenAt);
  const persistedBeforeInvalidScan = await readFile(store.filePath, 'utf8');

  assert.throws(() => store.recordScan([{ ip: 'missing-id' }], new Date('invalid')));
  assert.equal(await readFile(store.filePath, 'utf8'), persistedBeforeInvalidScan);
  assert.deepEqual(store.snapshot(seenAt), {
    ...before,
    entries: [{ id: 'host-1', ip: '192.168.1.10', lastSeenAt: seenAt.toISOString() }],
  });
});

test('does not expose a scan in memory when persistence fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ipam-state-'));
  const filePath = join(directory, 'state.json');
  const store = createStateStore(filePath);
  const seenAt = new Date('2026-09-01T00:00:00.000Z');
  const priorState = [{ id: 'host-1', ip: '192.168.1.10' }];

  store.recordScan(priorState, seenAt);
  rmSync(filePath);
  mkdirSync(filePath);

  assert.throws(() => store.recordScan(
    [{ id: 'host-2', ip: '192.168.1.11' }],
    new Date(seenAt.getTime() + hour),
  ));
  assert.deepEqual(store.snapshot(seenAt), {
    entries: [{ ...priorState[0], lastSeenAt: seenAt.toISOString() }],
  });
});
