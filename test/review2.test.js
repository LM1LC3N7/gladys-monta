// -----------------------------------------------------------------------------
// The scenarios of the first approval (R1, N2-N4), inverted.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES, MINUTE } from '../src/constants.js';
import { POINT_ID, charge } from './helpers/fakeMonta.js';
import {
  CONFIG,
  DAY,
  NOW,
  iso,
  montaServer,
  press,
  setup,
  starts,
  stops,
} from './helpers/review.js';

const ALLOWED = { ...CONFIG, allow_start: true, language: 'en' };
const EN = { ...CONFIG, language: 'en' };

test('R1/A2 a lone stop 20 s after a periodic read: a fresh read, the charge begun since is stopped', async (t) => {
  const server = montaServer();
  const ctx = await setup(t, { server, config: EN });
  await ctx.advance(2 * MINUTE + 1000);
  assert.equal(server.routes().filter((r) => r === 'GET charge-points').length, 2);
  await ctx.advance(5000);
  server.points[0].state = 'busy-charging';
  server.charges.push(charge({ id: 1800, state: 'charging', createdAt: iso(Date.now()) }));
  await ctx.advance(15_000);
  const ack = await press(ctx, FEATURES.STOP);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(stops(server), ['POST charges/1800/stop']);
});

test('R1 a burst of stops reuses the read of the first one only', async (t) => {
  const server = montaServer();
  const ctx = await setup(t, { server, config: EN });
  await ctx.advance(MINUTE);
  const count = () => server.routes().filter((r) => r === 'GET charges').length;
  const before = count();
  await press(ctx, FEATURES.STOP);
  await ctx.advance(5000);
  await press(ctx, FEATURES.STOP);
  await ctx.advance(5000);
  await press(ctx, FEATURES.STOP);
  assert.equal(count() - before, 1);
});

test('N2/A1b a kept charge, paused, out of the window, the point busy: the start is refused', async (t) => {
  const server = montaServer(
    { charges: [charge({ id: 952, state: 'paused', createdAt: iso(NOW - 7 * DAY + 30_000) })] },
    { filterFromDate: true },
  );
  const ctx = await setup(t, { server, config: ALLOWED });
  await ctx.advance(3 * MINUTE);
  assert.equal(ctx.app.known.get(POINT_ID), 952);
  const start = await press(ctx, FEATURES.START);
  assert.equal(start.success, false);
  assert.match(start.error, /still in progress on this charge point \(kept/);
  assert.deepEqual(starts(server), []);
});

test('N3/A10 a stop waiting for a slow token: "not sent yet", then it leaves', async (t) => {
  const server = montaServer({ charges: [charge({ id: 997, state: 'charging' })] });
  const ctx = await setup(t, { server, config: EN });
  await ctx.advance(30_000);
  ctx.app.client.tokens = { ...ctx.app.client.tokens, accessRenewAt: 0 };
  server.queue.push({
    match: (r) => r.path.endsWith('/auth/refresh'),
    wait: new Promise((resolve) => setTimeout(resolve, 96_000)),
  });
  await ctx.advance(91_000);
  assert.ok(ctx.app.client.authenticating);
  while (ctx.app.limiter.room() > 1) ctx.app.limiter.note();
  const ack = await press(ctx, FEATURES.STOP);
  assert.equal(ack.success, false);
  assert.match(ack.error, /Stop not sent yet/);
  assert.doesNotMatch(ack.error, /Command sent/);
  await ctx.advance(10_000, 100);
  assert.deepEqual(stops(server), ['POST charges/997/stop'], 'it left with the token');
});

test('Z6 a stop whose fresh read joins a slow token renewal answers Gladys within 5 s', async (t) => {
  const server = montaServer({ charges: [charge({ id: 998, state: 'charging' })] });
  const ctx = await setup(t, { server, config: EN });
  await ctx.advance(30_000);
  ctx.app.client.tokens = { ...ctx.app.client.tokens, accessRenewAt: 0 };
  server.queue.push({
    match: (r) => r.path.endsWith('/auth/refresh'),
    wait: new Promise((resolve) => setTimeout(resolve, 96_000)),
  });
  await ctx.advance(91_000);
  assert.ok(ctx.app.client.authenticating, 'a read waits for its slow renewal');
  assert.ok(ctx.app.limiter.room() >= 3, 'room for a fresh read');
  const clicked = Date.now();
  const ack = await press(ctx, FEATURES.STOP);
  assert.ok(Date.now() - clicked <= 5000, `answered after ${Date.now() - clicked} ms`);
  assert.equal(ack.success, false);
  assert.match(ack.error, /Stop not sent yet: it waits for a token from Monta and leaves only if/);
  await ctx.advance(10_000, 100);
  assert.deepEqual(stops(server), ['POST charges/998/stop'], 'it left with the token');
});

test('N4/A11 a 5xx on the charges: the status speaks of an outage, not of the scope', async (t) => {
  const server = montaServer();
  const ctx = await setup(t, { server, config: EN });
  await ctx.advance(MINUTE);
  server.queue.push({
    match: (r) => r.path === '/api/v1/charges' && r.method === 'GET',
    status: 503,
    body: {},
  });
  await ctx.advance(MINUTE + 1000);
  const text = ctx.gladys.fake.connectionStatus.message.en;
  assert.match(text, /charges are unavailable for now/);
  assert.doesNotMatch(text, /scope/);
});
