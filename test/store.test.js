import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOUR } from '../src/constants.js';
import { fileStore, fingerprint, normalizeMemory } from '../src/store.js';

const NOW = Date.parse('2026-10-22T10:00:00Z');
const HEX16 = 'abcdef0123456789';

test('the memory read back is repaired and bounded', () => {
  const memory = normalizeMemory(
    {
      lastAttemptAt: NOW + 10 * HOUR,
      pause: { kind: 'rate', until: NOW + 100 * HOUR },
      block: { account: HEX16, kind: 'refused', salt: HEX16, fingerprint: 'zz' },
      points: { account: HEX16, list: [{ id: 1, charge: 5 }, { id: -1 }, { id: 2, charge: 'x' }] },
    },
    NOW,
  );
  assert.equal(memory.lastAttemptAt, NOW, 'a time in the future counts as now');
  assert.deepEqual(memory.pause, { kind: 'rate', until: NOW + 24 * HOUR });
  assert.equal(memory.block, null, 'an odd fingerprint is dropped');
  assert.deepEqual(memory.points.list, [
    { id: 1, charge: 5 },
    { id: 2, charge: null },
  ]);
  assert.deepEqual(normalizeMemory('garbage', NOW), {
    lastAttemptAt: undefined,
    pause: null,
    block: null,
    points: null,
  });
});

test('the fingerprint is salted', () => {
  assert.notEqual(fingerprint('a'.repeat(32), 'id', 's'), fingerprint('b'.repeat(32), 'id', 's'));
  assert.match(fingerprint('a'.repeat(32), 'id', 's'), /^[0-9a-f]{64}$/);
});

test('the file store writes then renames, and reads back', async () => {
  // Inside the repository (removed at the end): never under the user's temp folder.
  const dir = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), '.tmp-store-'));
  try {
    const path = join(dir, 'state.json');
    const store = fileStore(path);
    assert.equal(await store.load(), null);
    await Promise.all([store.save({ a: 1 }), store.save({ a: 2 })]);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { a: 2 });
    assert.deepEqual(await store.load(), { a: 2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
