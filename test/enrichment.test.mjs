import assert from 'node:assert/strict';
import test from 'node:test';

import { enrichEntries } from '../enrichment.mjs';

test('prefers UniFi friendly names matched by MAC address', async () => {
  const entries = await enrichEntries([
    { id: 'mac-aa:bb:cc:dd:ee:01', ip: '192.168.1.10', mac: 'AA:BB:CC:DD:EE:01' },
  ], {
    lookupUniFi: async () => new Map([
      ['aa:bb:cc:dd:ee:01', { name: 'Living room TV', hostname: 'tv' }],
    ]),
    reverseDns: async () => 'reverse-name',
  });

  assert.equal(entries[0].hostname, 'Living room TV');
});

test('uses reverse DNS when UniFi has no matching name', async () => {
  const entries = await enrichEntries([
    { id: 'mac-aa:bb:cc:dd:ee:02', ip: '192.168.1.11', mac: 'aa:bb:cc:dd:ee:02' },
  ], {
    lookupUniFi: async () => new Map(),
    reverseDns: async ip => `${ip}.lan`,
  });

  assert.equal(entries[0].hostname, '192.168.1.11.lan');
});

test('keeps scan results usable when both hostname lookups fail', async () => {
  const entries = [{ id: 'mac-aa:bb:cc:dd:ee:03', ip: '192.168.1.12', mac: 'aa:bb:cc:dd:ee:03' }];

  assert.deepEqual(await enrichEntries(entries, {
    lookupUniFi: async () => { throw new Error('UniFi unavailable'); },
    reverseDns: async () => { throw new Error('DNS unavailable'); },
  }), entries);
});

test('does not overwrite a previously known hostname with an empty lookup', async () => {
  const entries = [{ id: 'mac-aa:bb:cc:dd:ee:04', ip: '192.168.1.13', mac: 'aa:bb:cc:dd:ee:04', hostname: 'previous-name' }];

  assert.deepEqual(await enrichEntries(entries, {
    lookupUniFi: async () => new Map([['aa:bb:cc:dd:ee:04', {}]]),
    reverseDns: async () => { throw new Error('DNS unavailable'); },
  }), entries);
});
