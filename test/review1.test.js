// -----------------------------------------------------------------------------
// The scenarios of the first review (B1, I1-I4, M1-M7), inverted: each one
// fails on the code reviewed and passes on the fix.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES, MINUTE } from '../src/constants.js';
import { MontaError } from '../src/monta.js';
import { POINT_ID, charge, chargePoint } from './helpers/fakeMonta.js';
import {
  CONFIG,
  DAY,
  NOW,
  chainedStore,
  iso,
  last,
  message,
  montaServer,
  press,
  setup,
  starts,
  stops,
} from './helpers/review.js';

const ALLOWED = { ...CONFIG, allow_start: true, language: 'en' };
const EN = { ...CONFIG, language: 'en' };

test('B1/S1 a charge in progress gone from the 7-day read: the stop goes to the kept charge', async (t) => {
  const server = montaServer(
    { charges: [charge({ id: 950, state: 'charging', createdAt: iso(NOW - 7 * DAY + 30_000) })] },
    { filterFromDate: true },
  );
  const ctx = await setup(t, { server, config: EN });
  await ctx.advance(60_000);
  const ack = await press(ctx, FEATURES.STOP);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(stops(server), ['POST charges/950/stop']);
  assert.equal(server.charges[0].state, 'stopped');
});

test('B1 the kept charge stays while the charge point is busy, even out of the read', async (t) => {
  const server = montaServer(
    {
      points: [chargePoint({ state: 'busy-charging' })],
      charges: [charge({ id: 952, state: 'charging', createdAt: iso(NOW - 7 * DAY + 60_000) })],
    },
    { filterFromDate: true },
  );
  const ctx = await setup(t, { server, config: EN });
  assert.deepEqual(ctx.store.data.points.list, [{ id: POINT_ID, charge: 952 }]);
  await ctx.advance(5 * MINUTE);
  assert.deepEqual(ctx.store.data.points.list, [{ id: POINT_ID, charge: 952 }], 'still kept');
});

test('B1/S1b charging for 8 days, never seen: the stop says so, the start is never sent', async (t) => {
  const server = montaServer(
    {
      points: [chargePoint({ state: 'busy-charging' })],
      charges: [charge({ id: 951, state: 'charging', createdAt: iso(NOW - 8 * DAY) })],
    },
    { filterFromDate: true },
  );
  const ctx = await setup(t, { server, config: ALLOWED });
  await ctx.advance(1000);
  const stop = await press(ctx, FEATURES.STOP);
  assert.equal(stop.success, false);
  assert.match(
    stop.error,
    /charging, but no charge in progress is among its charges of the last 7 days/,
  );
  await ctx.advance(MINUTE);
  const start = await press(ctx, FEATURES.START);
  assert.equal(start.success, true, 'already charging: nothing to do');
  assert.deepEqual(starts(server), []);
});

test('I2/S3 a stop right after a restart reads first and stops the charge begun meanwhile', async (t) => {
  const server = montaServer();
  const ctx = await setup(t, { server, config: EN });
  server.charges.push(charge({ id: 1500, state: 'charging', createdAt: iso(NOW + 30_000) }));
  await ctx.advance(30_000);
  await ctx.restart(EN);
  const ack = await press(ctx, FEATURES.STOP);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(stops(server), ['POST charges/1500/stop']);
});

test('I2/S4 the kept charge ended and a new one began: the stop goes to the new one', async (t) => {
  const server = montaServer({ charges: [charge({ id: 970, state: 'charging' })] });
  const ctx = await setup(t, { server, config: EN });
  server.charges[0].state = 'completed';
  server.charges.push(charge({ id: 1501, state: 'charging', createdAt: iso(NOW + 30_000) }));
  await ctx.advance(30_000);
  await ctx.restart(EN);
  const ack = await press(ctx, FEATURES.STOP);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(stops(server), ['POST charges/1501/stop']);
});

test('I2 no room after a restart: the kept charge, the reason told exactly when none is kept', async (t) => {
  const store = chainedStore();
  const server = montaServer({ charges: [charge({ id: 971, state: 'charging' })] });
  const ctx = await setup(t, { server, store, config: EN });
  // The minute spent before the restart (kept in /data with the state).
  for (let i = 0; i < 8; i += 1) ctx.app.limiter.note();
  await ctx.app.saveMemory();
  await ctx.restart(EN);
  let count = server.requests.length;
  let ack = await press(ctx, FEATURES.STOP);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(server.routes().slice(count), ['POST auth/token', 'POST charges/971/stop']);

  // Nothing kept and no room: refused, with the true reason.
  server.charges[0].state = 'stopped';
  ctx.app.known.set(POINT_ID, null);
  ctx.app.freshReads.clear();
  count = server.requests.length;
  ack = await press(ctx, FEATURES.STOP);
  assert.equal(ack.success, false);
  assert.match(ack.error, /limit of 10 requests per minute of Monta/);
  assert.equal(server.requests.length, count);
});

test('I3/S5a the token endpoint failing during a stop: "not sent", never "sent"', async (t) => {
  const server = montaServer({ charges: [charge({ id: 970, state: 'charging' })] });
  const ctx = await setup(t, { server, config: EN });
  await ctx.restart(EN);
  for (let i = 0; i < 3; i += 1) {
    server.queue.push({ match: (r) => r.path.endsWith('/auth/token'), status: 503, body: {} });
  }
  const ack = await press(ctx, FEATURES.STOP);
  assert.deepEqual(stops(server), []);
  assert.doesNotMatch(ack.error, /Command sent/);
  assert.match(ack.error, /was not sent/);
});

test('I3/S5b the token endpoint silent during a stop: never "sent"', async (t) => {
  const server = montaServer({ charges: [charge({ id: 970, state: 'charging' })] });
  const ctx = await setup(t, { server, config: EN });
  await ctx.restart(EN);
  server.queue.push({
    match: (r) => r.path.endsWith('/auth/token'),
    wait: new Promise((resolve) => setTimeout(resolve, 3500)),
    error: new MontaError('timeout', 'no answer within 3 s', { notSent: false }),
  });
  server.queue.push({
    match: (r) => r.path.endsWith('/auth/token'),
    error: new MontaError('timeout', 'no answer within 3 s', { notSent: false }),
  });
  const ack = await press(ctx, FEATURES.STOP);
  assert.deepEqual(stops(server), []);
  assert.equal(ack.success, false);
  assert.doesNotMatch(ack.error, /Command sent/);
});

test('I3/S5c a start refused (401), the refresh failing: "not sent", nothing armed', async (t) => {
  const server = montaServer();
  const ctx = await setup(t, { server, config: ALLOWED });
  await ctx.advance(MINUTE);
  server.queue.push({
    match: (r) => r.method === 'POST' && r.path.endsWith('/charges'),
    status: 401,
    body: {},
  });
  server.queue.push({ match: (r) => r.path.endsWith('/auth/refresh'), status: 503, body: {} });
  const ack = await press(ctx, FEATURES.START);
  assert.match(ack.error, /was not sent/);
  assert.equal(ctx.app.unconfirmedUntil.get(POINT_ID), undefined);
});

test('M1/S6b a 429 answering a stop of the old configuration leaves the new one alone', async (t) => {
  const server = montaServer({ charges: [charge({ id: 975, state: 'charging' })] });
  const ctx = await setup(t, { server, config: EN });
  await ctx.advance(MINUTE);
  server.queue.push({
    match: (r) => r.path.endsWith('/stop'),
    wait: new Promise((resolve) => setTimeout(resolve, 1500)),
    status: 429,
    headers: { 'retry-after': '3600' },
    body: {},
  });
  const stop = press(ctx, FEATURES.STOP);
  await ctx.advance(500, 100);
  server.clientId = 'other-user';
  server.clientSecret = 'other-secret';
  await ctx.gladys.fake.configUpdated({
    client_id: 'other-user',
    client_secret: 'other-secret',
    language: 'en',
  });
  await stop;
  await ctx.advance(2000, 100);
  assert.ok(ctx.app.pausedUntil <= Date.now(), 'the new account is not paused');
  assert.doesNotMatch(message(ctx.gladys).en, /slow down/);
});

test('I1/S7 a scene pressing stop every 10 s never starves the periodic reads', async (t) => {
  const server = montaServer();
  const ctx = await setup(t, { server, config: EN });
  const reads = () => server.routes().filter((r) => r === 'GET charge-points').length;
  const before = reads();
  for (let i = 0; i < 60; i += 1) {
    await press(ctx, FEATURES.STOP);
    await ctx.advance(10_000 - 300);
  }
  assert.ok(reads() - before >= 4, `${reads() - before} periodic reads in 10 min`);
  const charges = server.routes().filter((r) => r === 'GET charges').length;
  assert.ok(charges <= 2 * 10 + 6, `${charges} reads of the charges`);
});

test('I4/S8 a start lost, then a stop: the charge landing as "scheduled" is stopped', async (t) => {
  const server = montaServer();
  const ctx = await setup(t, { server, config: ALLOWED });
  await ctx.advance(MINUTE);
  server.queue.push({
    match: (r) => r.method === 'POST' && r.path.endsWith('/charges'),
    wait: new Promise((resolve) => setTimeout(resolve, 6000)),
    status: 504,
    body: {},
  });
  const start = await press(ctx, FEATURES.START);
  assert.match(start.error, /without confirmation/);
  const stop = await press(ctx, FEATURES.STOP);
  assert.equal(stop.success, true, stop.error);
  server.charges.push(charge({ id: 1600, state: 'scheduled', createdAt: iso(Date.now()) }));
  await ctx.advance(3 * MINUTE);
  assert.deepEqual(stops(server), ['POST charges/1600/stop']);
});

test('I4/S9 a stop with no room while a start may land: refused, the watch armed all the same', async (t) => {
  const server = montaServer();
  const ctx = await setup(t, { server, config: ALLOWED });
  await ctx.advance(2 * MINUTE + 1000);
  server.queue.push({
    match: (r) => r.method === 'POST' && r.path.endsWith('/charges'),
    wait: new Promise((resolve) => setTimeout(resolve, 6000)),
    status: 504,
    body: {},
  });
  await press(ctx, FEATURES.START);
  // The minute is spent by other applications of the user (simulated).
  for (let i = 0; i < 10; i += 1) ctx.app.limiter.note();
  const stop = await press(ctx, FEATURES.STOP);
  assert.equal(stop.success, false);
  assert.match(stop.error, /a start sent may still land: it will be stopped/);
  server.charges.push(charge({ id: 1700, state: 'charging', createdAt: iso(Date.now()) }));
  await ctx.advance(5 * MINUTE);
  assert.deepEqual(stops(server), ['POST charges/1700/stop']);
});

test('M2/S10 a 403 on the charge points keeps no fingerprint of working credentials', async (t) => {
  const server = montaServer();
  server.queue.push({ match: (r) => r.path.endsWith('/charge-points'), status: 403, body: {} });
  const ctx = await setup(t, { server, config: EN });
  assert.equal(ctx.store.data.block.kind, 'forbidden');
  assert.equal(ctx.store.data.block.fingerprint, undefined);
  assert.equal(ctx.store.data.block.salt, undefined);
  // Saving the credentials again (scope added in the portal) tries at once.
  await ctx.gladys.fake.configUpdated({ ...EN, client_secret: CONFIG.client_secret });
  await ctx.gladys.fake.configUpdated({ ...EN, client_secret: 'x' });
  await ctx.gladys.fake.configUpdated(EN);
  await ctx.advance(1000);
  assert.equal(ctx.store.data.block, null);
});

test('M5/S11 the clock of Monta 2 h behind: no refresh before every request', async (t) => {
  const server = montaServer();
  const issue = server.issue.bind(server);
  server.issue = () => {
    const json = issue();
    json.accessTokenExpirationDate = new Date(Date.now() - 3600_000).toISOString();
    return json;
  };
  const ctx = await setup(t, { server, config: EN });
  await ctx.advance(10 * MINUTE);
  const refreshes = server.routes().filter((r) => r === 'POST auth/refresh').length;
  assert.equal(refreshes, 0);
});

test('M7/S13 without the "charge-transactions" scope, the stop refusal says why', async (t) => {
  const server = montaServer({ charges: [charge({ id: 985, state: 'charging' })] });
  const transport = server.transport;
  server.transport = (url, init = {}) =>
    new URL(url).pathname === '/api/v1/charges' && (init.method ?? 'GET') === 'GET'
      ? Promise.resolve({ status: 403, headers: {}, body: '{}' })
      : transport(url, init);
  const ctx = await setup(t, { server, config: EN });
  await ctx.advance(3 * MINUTE);
  const ack = await press(ctx, FEATURES.STOP);
  assert.equal(ack.success, false);
  assert.match(ack.error, /HTTP 403/);
});

test('M7/S14 failing resends: the watch ends within 10 min, follow-up reads a minute apart', async (t) => {
  const server = montaServer({ charges: [charge({ id: 986, state: 'charging' })] });
  const ctx = await setup(t, { server, config: EN });
  await ctx.advance(MINUTE);
  const ack = await press(ctx, FEATURES.STOP);
  assert.equal(ack.success, true);
  server.charges[0].state = 'charging';
  for (let i = 0; i < 40; i += 1) {
    server.queue.push({ match: (r) => r.path.endsWith('/stop'), status: 503, body: {} });
  }
  const before = server.routes().filter((r) => r === 'GET charge-points').length;
  await ctx.advance(15 * MINUTE);
  const reads = server.routes().filter((r) => r === 'GET charge-points').length - before;
  assert.ok(reads <= 16, `${reads} reads in 15 min`);
  assert.equal(ctx.app.watches.has(POINT_ID), false, 'the watch ended');
});

test('M6/S15 tokens revoked during the first interval: the stop logs in again and goes', async (t) => {
  const server = montaServer({ charges: [charge({ id: 987, state: 'charging' })] });
  const ctx = await setup(t, { server, config: EN });
  await ctx.advance(30_000);
  server.accessTokens.clear();
  server.refreshTokens.clear();
  const ack = await press(ctx, FEATURES.STOP);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(stops(server), ['POST charges/987/stop']);
});

test('M3/S16 a 5xx on the charges only: still connected, no pause, starts possible', async (t) => {
  const server = montaServer();
  const ctx = await setup(t, { server, config: ALLOWED });
  await ctx.advance(MINUTE);
  server.queue.push({
    match: (r) => r.path === '/api/v1/charges' && r.method === 'GET' && !r.query.chargePointId,
    status: 503,
    body: {},
  });
  await ctx.advance(MINUTE + 1000);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
  assert.equal(ctx.store.data.pause, null);
  assert.equal(ctx.app.offline, false);
  const start = await press(ctx, FEATURES.START);
  assert.equal(start.success, true, start.error);
  assert.equal(last(ctx.gladys, FEATURES.PLUGGED), 1);
});
