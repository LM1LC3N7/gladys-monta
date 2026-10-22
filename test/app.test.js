// -----------------------------------------------------------------------------
// End to end: the real SDK wiring (src/handlers.js) against the SDK's fake
// Gladys and a fake Monta API behind the transport. Timers and Date are
// mocked: the tests move the clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { MontaApp } from '../src/app.js';
import { ACTIONS, FEATURES, MINUTE, HOUR } from '../src/constants.js';
import { CHARGING_STATE, CONNECTOR_STATUS } from '../src/devices.js';
import { registerHandlers } from '../src/handlers.js';
import {
  CLIENT_ID,
  CLIENT_SECRET,
  POINT_ID,
  SERIAL,
  charge,
  chargePoint,
  fakeMonta,
  memoryStore,
  settle,
} from './helpers/fakeMonta.js';

const NOW = Date.parse('2026-10-22T10:00:00Z');
const CONFIG = { client_id: CLIENT_ID, client_secret: CLIENT_SECRET };
const DEVICE = `ext:test-integration:monta:${POINT_ID}`;
const feature = (role) => `${DEVICE}:${role}`;

async function setup(
  t,
  {
    config = CONFIG,
    store = memoryStore(),
    server = fakeMonta(),
    now = NOW,
    create = true,
    logs = [],
    timers = true,
  } = {},
) {
  if (timers) {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  }
  const gladys = createFakeGladys({ config });
  const app = new MontaApp({
    gladys,
    logger: recorder(logs),
    transport: server.transport,
    now: () => Date.now(),
    store,
  });
  registerHandlers(gladys, app);
  t.after(() => app.stop());
  const advance = async (ms, step = 1000) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      t.mock.timers.tick(Math.min(step, ms - elapsed));
      await settle();
    }
  };
  await gladys.connect();
  await settle();
  await advance(1);
  if (create && gladys.fake.discoveredDevices.length > 0) {
    await gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]);
    await settle();
  }
  return { gladys, app, server, store, advance, logs };
}

/** A logger keeping every line, to check that no secret ever reaches the logs. */
const recorder = (logs) =>
  Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')),
    ]),
  );

const last = (gladys, role) => gladys.fake.lastState(feature(role));
const message = (gladys) => gladys.fake.connectionStatus?.message ?? {};
const deviceOf = (gladys) => gladys.fake.discoveredDevices.at(-1);
const featureOf = (gladys, role) =>
  deviceOf(gladys).features.find((f) => f.external_id === feature(role));

/** Clicks a button and moves the clock until Gladys gets its answer. */
async function press(ctx, role, value = 1) {
  const { gladys, advance } = ctx;
  const pending = gladys.fake.setValue(deviceOf(gladys), featureOf(gladys, role), value);
  let ack;
  pending.then((a) => {
    ack = a;
  });
  for (let i = 0; i < 60 && ack === undefined; i += 1) {
    await advance(100, 100);
  }
  return ack;
}

const noSecret = (server, store, logs) => {
  const saved = JSON.stringify(store.data ?? {});
  const all = logs.join('\n');
  for (const secret of [...server.secrets, CLIENT_ID, SERIAL, '1 Private Street', '55.1']) {
    assert.ok(!saved.includes(secret), `${secret} reached /data`);
    assert.ok(!all.includes(secret), `${secret} reached the logs`);
  }
};

test('without credentials, the status asks for them and nothing is requested', async (t) => {
  const { gladys, server } = await setup(t, { config: { client_id: CLIENT_ID } });
  assert.equal(server.requests.length, 0);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).en, /client secret/);
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.fr, /secret client/);
  assert.equal(server.requests.length, 0);
});

test('one token, the charge points, the charges: device, states, status; no secret anywhere', async (t) => {
  const logs = [];
  const ctx = await setup(t, { logs });
  const { gladys, server, store } = ctx;
  assert.deepEqual(server.routes(), ['POST auth/token', 'GET charge-points', 'GET charges']);
  assert.deepEqual(server.requests[0].json, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  assert.match(server.requests[1].headers.Authorization, /^Bearer access-1-secret$/);
  assert.equal(server.requests[1].query.perPage, '100');
  assert.match(server.requests[2].query.fromDate, /^2026-10-15T10:00:00Z$/);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(message(gladys).en, /1 charge point/);

  const device = deviceOf(gladys);
  assert.equal(device.external_id, DEVICE);
  assert.equal(device.name, 'Garage');
  assert.equal(device.model, 'Easee Home');
  assert.deepEqual(
    device.features.map((f) => [
      f.external_id.slice(DEVICE.length + 1),
      f.category,
      f.type,
      f.unit,
      f.read_only,
    ]),
    [
      ['status', 'text', 'text', undefined, true],
      ['connector-status', 'charging-station', 'connector-status', undefined, true],
      ['charging-state', 'charging-station', 'charging-state', undefined, true],
      ['plugged', 'electrical-vehicle-charge', 'plugged', undefined, true],
      ['charge-status', 'text', 'text', undefined, true],
      [
        'session-energy',
        'electrical-vehicle-charge',
        'last-charge-energy-added',
        'kilowatt-hour',
        true,
      ],
      ['vehicle-battery', 'electrical-vehicle-battery', 'battery-level', 'percent', true],
      [
        'meter-reading',
        'electrical-vehicle-charge',
        'charge-energy-consumption-total',
        'kilowatt-hour',
        true,
      ],
      ['start-charge', 'button', 'push', undefined, false],
      ['stop-charge', 'button', 'push', undefined, false],
    ],
  );
  assert.ok(device.features.every((f) => !(f.type === 'binary' && !f.read_only)));
  assert.ok(!device.features.some((f) => f.category === 'switch'));

  await ctx.advance(1000);
  assert.equal(last(gladys, FEATURES.STATUS), 'Véhicule branché, sans charge');
  assert.equal(last(gladys, FEATURES.CONNECTOR), CONNECTOR_STATUS.OCCUPIED);
  assert.equal(last(gladys, FEATURES.CHARGING_STATE), CHARGING_STATE.EV_CONNECTED);
  assert.equal(last(gladys, FEATURES.PLUGGED), 1);
  assert.equal(last(gladys, FEATURES.CHARGE_STATUS), 'Terminée');
  assert.equal(last(gladys, FEATURES.SESSION_ENERGY), 12.345);
  assert.equal(last(gladys, FEATURES.VEHICLE_BATTERY), 80);
  assert.equal(last(gladys, FEATURES.METER), 1234.5);
  assert.deepEqual(gladys.fake.transports.at(-1), {
    device_external_id: DEVICE,
    transport: DEVICE_TRANSPORTS.CLOUD,
  });

  assert.equal(store.data.lastAttemptAt, NOW + 1);
  assert.deepEqual(store.data.points.list, [{ id: POINT_ID, charge: null }]);
  noSecret(server, store, logs);
});

test('never read sooner than the interval: test button, connected, unchanged config, restart', async (t) => {
  const store = memoryStore();
  const server = fakeMonta();
  const ctx = await setup(t, { store, server });
  const { gladys, app } = ctx;
  const count = server.requests.length;

  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /Not read again before the refresh interval/);
  assert.equal(server.requests.length, count, 'test button');
  await gladys.fake.configUpdated(CONFIG);
  await settle();
  assert.equal(server.requests.length, count, 'unchanged config');
  await app.connected(CONFIG);
  await settle();
  assert.equal(server.requests.length, count, 'connected');
  // Status and Discovery are sent again on a reconnection.
  assert.equal(gladys.fake.connectionStatus.connected, true);

  // A restart of the container 30 s later waits for the rest of the interval.
  await ctx.advance(30_000);
  app.stop();
  const again = new MontaApp({
    gladys,
    logger: recorder([]),
    transport: server.transport,
    now: () => Date.now(),
    store,
  });
  t.after(() => again.stop());
  await again.start(CONFIG);
  await ctx.advance(60_000);
  assert.equal(server.requests.length, count);
  assert.match(message(gladys).en, /Waiting for the refresh interval/);
  await ctx.advance(31_000);
  assert.ok(server.requests.length > count);

  // The periodic read follows the interval (120 s by default).
  const before = server.api().length;
  await ctx.advance(115_000);
  assert.equal(server.api().length, before);
  await ctx.advance(6_000);
  assert.equal(server.api().length, before + 2);
});

test('refused credentials: final stop in /data, no automatic try; other credentials lift it', async (t) => {
  const store = memoryStore();
  const server = fakeMonta();
  server.clientSecret = 'another';
  const logs = [];
  const ctx = await setup(t, { store, server, logs });
  const { gladys, app } = ctx;
  assert.deepEqual(server.routes(), ['POST auth/token']);
  assert.match(message(gladys).en, /refused the client id or the client secret/);
  assert.equal(store.data.block.kind, 'refused');
  assert.ok(!JSON.stringify(store.data).includes(CLIENT_SECRET));

  await ctx.advance(48 * HOUR, HOUR);
  assert.equal(server.requests.length, 1, 'never tried again by itself');

  // A restart with the same credentials stays stopped.
  await app.start(CONFIG);
  await ctx.advance(10 * MINUTE, MINUTE);
  assert.equal(server.requests.length, 1);

  // The test button tries once; refused again, still stopped.
  let ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /refused/);
  assert.equal(server.requests.length, 2);
  await ctx.advance(10 * MINUTE, MINUTE);
  assert.equal(server.requests.length, 2);

  // Fixed on the Monta side: the button succeeds and lifts the stop.
  server.clientSecret = CLIENT_SECRET;
  await ctx.advance(3 * MINUTE, MINUTE);
  ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /Connected to Monta/);
  assert.equal(store.data.block, null);
  noSecret(server, store, logs);
});

test('new credentials saved lift the stop at once', async (t) => {
  const store = memoryStore();
  const server = fakeMonta();
  server.clientSecret = 'the-real-one';
  const ctx = await setup(t, { store, server });
  assert.equal(store.data.block.kind, 'refused');
  await ctx.gladys.fake.configUpdated({ ...CONFIG, client_secret: 'the-real-one' });
  await ctx.advance(3 * MINUTE, MINUTE);
  assert.equal(store.data.block, null);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
});

test('a 429 pauses every read (persisted), a stop still goes out', async (t) => {
  const store = memoryStore();
  const server = fakeMonta({ charges: [charge({ id: 950, state: 'charging' })] });
  const ctx = await setup(t, { store, server });
  const { gladys } = ctx;
  await ctx.advance(2 * MINUTE);
  server.queue.push({
    match: (r) => r.path.endsWith('/charge-points'),
    status: 429,
    headers: { 'retry-after': '600' },
  });
  await ctx.advance(2 * MINUTE);
  assert.match(message(gladys).en, /slow down/);
  assert.equal(store.data.pause.kind, 'rate');
  const count = server.requests.length;
  await ctx.advance(5 * MINUTE, MINUTE);
  assert.equal(server.requests.length, count, 'no read during the pause');

  const ack = await press(ctx, FEATURES.STOP);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(server.routes().slice(count), ['POST charges/950/stop']);
});

test('start: disabled by default, nothing sent', async (t) => {
  const ctx = await setup(t);
  const count = ctx.server.requests.length;
  const ack = await press(ctx, FEATURES.START);
  assert.equal(ack.success, false);
  assert.match(ack.error, /Autoriser le démarrage/);
  assert.equal(ctx.server.requests.length, count);
});

test('start allowed: a fresh read, then one request; the charge follows', async (t) => {
  const ctx = await setup(t, { config: { ...CONFIG, allow_start: true, language: 'en' } });
  const { server } = ctx;
  const count = server.requests.length;
  const ack = await press(ctx, FEATURES.START);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(server.routes().slice(count).sort(), [
    'GET charge-points/4711',
    'GET charges',
    'POST charges',
  ]);
  assert.deepEqual(server.commands()[0].json, { chargePointId: POINT_ID });
  // The follow-up read waits for room under the limit of Monta.
  await ctx.advance(70_000);
  assert.equal(last(ctx.gladys, FEATURES.CHARGE_STATUS), 'Starting');
});

test('start refused on the state just read: no vehicle, already charging, a fault', async (t) => {
  const server = fakeMonta();
  const ctx = await setup(t, { server, config: { ...CONFIG, allow_start: true, language: 'en' } });
  server.points[0] = chargePoint({ cablePluggedIn: false, state: 'available' });
  let ack = await press(ctx, FEATURES.START);
  assert.match(ack.error, /No vehicle is plugged in/);
  await ctx.advance(MINUTE);
  server.points[0] = chargePoint({ state: 'error' });
  ack = await press(ctx, FEATURES.START);
  assert.match(ack.error, /cannot start a charge now \(Error\)/);
  await ctx.advance(MINUTE);
  server.points[0] = chargePoint({ state: 'busy-charging' });
  server.charges.push(charge({ id: 990, state: 'charging' }));
  ack = await press(ctx, FEATURES.START);
  assert.equal(ack.success, true, 'already charging: nothing to do');
  assert.equal(server.commands().length, 0);
});

test('the option turned off during the fresh read: the start is not sent', async (t) => {
  const ctx = await setup(t, { config: { ...CONFIG, allow_start: true, language: 'en' } });
  const { server, gladys } = ctx;
  const release = server.hold((r) => r.path.endsWith('/charge-points/4711'));
  const pending = press(ctx, FEATURES.START);
  await settle();
  await gladys.fake.configUpdated({ ...CONFIG, allow_start: false, language: 'en' });
  release();
  const ack = await pending;
  assert.match(ack.error, /disabled/);
  assert.equal(server.commands().length, 0);
});

test('a stop clicked during the read of a start cancels the start', async (t) => {
  const server = fakeMonta({ charges: [charge({ id: 960, state: 'charging' })] });
  const ctx = await setup(t, { server, config: { ...CONFIG, allow_start: true, language: 'en' } });
  server.charges[0].state = 'completed';
  await ctx.advance(3 * MINUTE, MINUTE);
  const release = server.hold((r) => r.path.endsWith('/charge-points/4711'));
  const start = press(ctx, FEATURES.START);
  await settle();
  const stop = press(ctx, FEATURES.STOP);
  await settle();
  release();
  const [startAck, stopAck] = await Promise.all([start, stop]);
  assert.match(startAck.error, /A stop arrived meanwhile/);
  assert.equal(stopAck.success, true, stopAck.error);
  assert.ok(!server.routes().includes('POST charges'));
});

test('a start Monta answers late: "sent, without confirmation", then the state follows', async (t) => {
  const ctx = await setup(t, { config: { ...CONFIG, allow_start: true, language: 'en' } });
  const { server } = ctx;
  const release = server.hold((r) => r.method === 'POST' && r.path.endsWith('/charges'), {});
  const ack = await press(ctx, FEATURES.START);
  assert.equal(ack.success, false);
  assert.match(ack.error, /Command sent, without confirmation yet/);
  release();
  await settle();
  // Still in flight until it settled; now free.
  await ctx.advance(70_000);
  assert.equal(last(ctx.gladys, FEATURES.CHARGE_STATUS), 'Starting');
});

test('a stop after a restart, before the first read: the charge kept in /data', async (t) => {
  const store = memoryStore();
  const server = fakeMonta({ charges: [charge({ id: 970, state: 'charging' })] });
  const ctx = await setup(t, { store, server });
  assert.deepEqual(store.data.points.list, [{ id: POINT_ID, charge: 970 }]);
  ctx.app.stop();
  const again = new MontaApp({
    gladys: ctx.gladys,
    logger: recorder([]),
    transport: server.transport,
    now: () => Date.now(),
    store,
  });
  t.after(() => again.stop());
  await again.start(CONFIG);
  const count = server.requests.length;
  const pending = again.setValue(deviceOf(ctx.gladys), featureOf(ctx.gladys, FEATURES.STOP), 1);
  await ctx.advance(500, 100);
  await pending;
  // Room left: one fresh read first, then the stop.
  assert.deepEqual(server.routes().slice(count), [
    'POST auth/token',
    'GET charges',
    'POST charges/970/stop',
  ]);
});

test('a 403 on a command refuses that command only: the reads go on', async (t) => {
  const server = fakeMonta({ charges: [charge({ id: 980, state: 'charging' })] });
  const ctx = await setup(t, { server, config: { ...CONFIG, language: 'en' } });
  server.queue.push({
    match: (r) => r.path.endsWith('/stop'),
    status: 403,
    body: { errorCode: 'FORBIDDEN' },
  });
  const ack = await press(ctx, FEATURES.STOP);
  assert.match(ack.error, /control-charging/);
  const before = server.api().length;
  await ctx.advance(3 * MINUTE, MINUTE);
  assert.ok(server.api().length > before);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
});

test('a stop that may race a start sent without answer is reaffirmed once a charge shows up', async (t) => {
  const server = fakeMonta();
  const ctx = await setup(t, { server, config: { ...CONFIG, allow_start: true, language: 'en' } });
  // The start leaves, Monta never answers in time.
  server.queue.push({
    match: (r) => r.method === 'POST' && r.path.endsWith('/charges'),
    status: 502,
    body: {},
  });
  const ack = await press(ctx, FEATURES.START);
  assert.match(ack.error, /Command sent, without confirmation/);
  // The stop: nothing in progress yet, but the start may still land.
  const stop = await press(ctx, FEATURES.STOP);
  assert.equal(stop.success, true, stop.error);
  // The start landed after all.
  server.charges.push(charge({ id: 1500, state: 'charging' }));
  await ctx.advance(3 * MINUTE, 1000);
  assert.ok(server.routes().includes('POST charges/1500/stop'));
  assert.equal(server.charges.find((c) => c.id === 1500).state, 'stopped');
});

test('a late answer of an old configuration publishes nothing', async (t) => {
  const server = fakeMonta();
  const release = server.hold((r) => r.path.endsWith('/charge-points'));
  const ctx = await setup(t, { server, create: false });
  assert.equal(ctx.gladys.fake.discoveredDevices.length, 0);
  await ctx.gladys.fake.configUpdated({ client_id: 'other', client_secret: 'other-secret' });
  release();
  await ctx.advance(1000);
  assert.equal(ctx.gladys.fake.discoveredDevices.length, 0);
  assert.match(message(ctx.gladys).en, /refused/);
});

test('a feature that is not a command, a bad value: refused, nothing sent', async (t) => {
  const ctx = await setup(t);
  const count = ctx.server.requests.length;
  const status = await ctx.gladys.fake.setValue(
    deviceOf(ctx.gladys),
    featureOf(ctx.gladys, FEATURES.STATUS),
    1,
  );
  assert.match(status.error, /lecture seule/);
  const bad = await press(ctx, FEATURES.STOP, 0);
  assert.match(bad.error, /Valeur invalide/);
  assert.equal(ctx.server.requests.length, count);
});

test('the charges endpoint failing never hides the charge points', async (t) => {
  const server = fakeMonta();
  server.queue.push({ match: (r) => r.path.endsWith('/charges'), status: 403, body: {} });
  const ctx = await setup(t, { server });
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
  assert.match(message(ctx.gladys).en, /charges could not be read/);
  await ctx.advance(1000);
  assert.equal(last(ctx.gladys, FEATURES.PLUGGED), 1);
  assert.equal(last(ctx.gladys, FEATURES.CHARGE_STATUS), undefined);
});
