import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createScanManager } from '../scan-manager.mjs';
import { scanNetwork } from '../scanner.mjs';
import { createStateStore } from '../state.mjs';

async function storeForTest() {
  const directory = await mkdtemp(join(tmpdir(), 'ipam-scan-manager-'));
  return createStateStore(join(directory, 'state.json'));
}

test('a successful scan normalizes and merges scanner records into state', async () => {
  const store = await storeForTest();
  const scannedAt = new Date('2026-09-02T08:00:00.000Z');
  const scanner = () => scanNetwork({
    command: 'lan-scan',
    args: ['192.168.1.0/24'],
    timeoutMs: 2_000,
    exec(command, args, options, callback) {
      assert.equal(command, 'lan-scan');
      assert.deepEqual(args, ['192.168.1.0/24']);
      assert.equal(options.timeout, 2_000);
      callback(null, [
        JSON.stringify({ id: ' host-1 ', ip: ' 192.168.1.10 ', hostname: ' nas ', ignored: true }),
        JSON.stringify({ id: 'host-2', ip: '192.168.1.11', mac: ' AA:BB:CC:DD:EE:FF ' }),
        '',
      ].join('\n'), '');
    },
  });
  const manager = createScanManager({ scanner, store, now: () => scannedAt });

  const status = await manager.scan();

  assert.deepEqual(status, {
    ok: true,
    entries: [
      {
        id: 'host-1',
        ip: '192.168.1.10',
        hostname: 'nas',
        lastSeenAt: scannedAt.toISOString(),
      },
      {
        id: 'host-2',
        ip: '192.168.1.11',
        mac: 'aa:bb:cc:dd:ee:ff',
        lastSeenAt: scannedAt.toISOString(),
      },
    ],
    lastSuccessfulScanAt: scannedAt.toISOString(),
    lastAttemptAt: scannedAt.toISOString(),
    scanInProgress: false,
    error: null,
  });
  assert.deepEqual(store.snapshot(scannedAt).entries, status.entries);
});

test('a failed scan retains state and exposes the scanner error', async () => {
  const store = await storeForTest();
  const firstScanAt = new Date('2026-09-02T08:00:00.000Z');
  const failedScanAt = new Date('2026-09-02T08:05:00.000Z');
  store.recordScan([{ id: 'host-1', ip: '192.168.1.10' }], firstScanAt);
  const manager = createScanManager({
    scanner: async () => {
      throw new Error('scanner timed out');
    },
    store,
    now: () => failedScanAt,
  });

  const status = await manager.scan();

  assert.deepEqual(status, {
    ok: false,
    entries: [{
      id: 'host-1',
      ip: '192.168.1.10',
      lastSeenAt: firstScanAt.toISOString(),
    }],
    lastSuccessfulScanAt: null,
    lastAttemptAt: failedScanAt.toISOString(),
    scanInProgress: false,
    error: 'scanner timed out',
  });
  assert.deepEqual(store.snapshot(failedScanAt).entries, status.entries);
});

test('status removes entries once they have been absent for 48 hours even after failed scans', async () => {
  const store = await storeForTest();
  const seenAt = new Date('2026-09-02T08:00:00.000Z');
  const now = new Date(seenAt.getTime() + 48 * 60 * 60 * 1000);
  store.recordScan([{ id: 'host-1', ip: '192.168.1.10' }], seenAt);
  const manager = createScanManager({
    scanner: async () => { throw new Error('unavailable'); },
    store,
    now: () => now,
  });

  const status = await manager.scan();

  assert.deepEqual(status.entries, []);
  assert.deepEqual(manager.getStatus().entries, []);
});

test('automatic scans use an interval of exactly five minutes', async () => {
  const store = await storeForTest();
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let configuredDelay;
  let scheduledScan;
  const timer = { timer: true };
  globalThis.setInterval = (callback, delay) => {
    scheduledScan = callback;
    configuredDelay = delay;
    return timer;
  };
  let scans = 0;
  const manager = createScanManager({
    scanner: async () => {
      scans += 1;
      return [];
    },
    store,
    now: () => new Date('2026-09-02T08:00:00.000Z'),
  });

  let initialScan;
  try {
    initialScan = manager.start();
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
  await initialScan;
  await scheduledScan();
  globalThis.clearInterval = (handle) => assert.equal(handle, timer);
  try {
    manager.stop();
  } finally {
    globalThis.clearInterval = originalClearInterval;
  }

  assert.equal(configuredDelay, 300_000);
  assert.equal(scans, 2);
});

test('two concurrent scan calls invoke the scanner once', async () => {
  const store = await storeForTest();
  let resolveScanner;
  let scannerCalls = 0;
  const scannerResult = new Promise((resolve) => {
    resolveScanner = resolve;
  });
  const manager = createScanManager({
    scanner: () => {
      scannerCalls += 1;
      return scannerResult;
    },
    store,
    now: () => new Date('2026-09-02T08:00:00.000Z'),
  });

  const first = manager.scan();
  const second = manager.scan();

  assert.equal(first, second);
  assert.equal(scannerCalls, 1);
  resolveScanner([]);
  await first;
});

test('scanner parses realistic arp-scan table output', async () => {
  const output = [
    'Interface: eth0, type: EN10MB, MAC: aa:bb:cc:dd:ee:ff, IPv4: 192.168.1.2',
    'Starting arp-scan 1.10.0 with 256 hosts',
    '192.168.1.10\taa:bb:cc:dd:ee:01\tExample vendor',
    '192.168.1.11\tAA:BB:CC:DD:EE:02\tAnother vendor',
    '2 packets received by filter, 0 packets dropped by kernel',
    'Ending arp-scan 1.10.0: 256 hosts scanned in 2.001 seconds',
  ].join('\n');

  const entries = await scanNetwork({
    command: 'arp-scan',
    args: ['--localnet'],
    timeoutMs: 2_000,
    exec(command, args, options, callback) {
      callback(null, output, '');
    },
  });

  assert.deepEqual(entries, [
    { id: 'mac-aa:bb:cc:dd:ee:01', ip: '192.168.1.10', mac: 'aa:bb:cc:dd:ee:01' },
    { id: 'mac-aa:bb:cc:dd:ee:02', ip: '192.168.1.11', mac: 'aa:bb:cc:dd:ee:02' },
  ]);
});
