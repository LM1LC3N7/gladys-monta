// -----------------------------------------------------------------------------
// The bench of the first review: the real app through the real handlers,
// against the SDK's fake Gladys and the fake Monta, a mocked clock, a store
// whose writes are chained like fileStore, and restarts of the container.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { MontaApp } from '../../src/app.js';
import { registerHandlers } from '../../src/handlers.js';
import { CLIENT_ID, CLIENT_SECRET, POINT_ID, fakeMonta, settle } from './fakeMonta.js';

export const NOW = Date.parse('2026-10-22T10:00:00Z');
export const DAY = 24 * 3600_000;
export const CONFIG = { client_id: CLIENT_ID, client_secret: CLIENT_SECRET };
export const DEVICE = `ext:test-integration:monta:${POINT_ID}`;
export const feature = (role) => `${DEVICE}:${role}`;
export const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export const recorder = (logs) =>
  Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map(String).join(' ')}`),
    ]),
  );

/** A store like fileStore: writes chained, in order. */
export function chainedStore(initial = null) {
  let chain = Promise.resolve();
  const store = {
    data: initial,
    saves: 0,
    async load() {
      return store.data === null ? null : structuredClone(store.data);
    },
    save(data) {
      const copy = structuredClone(data);
      const write = chain.then(() => {
        store.saves += 1;
        store.data = copy;
      });
      chain = write.catch(() => {});
      return write;
    },
  };
  return store;
}

/** The fake Monta, with `fromDate` applied on `createdAt` when `filterFromDate`. */
export function montaServer(options = {}, { filterFromDate = false } = {}) {
  const server = fakeMonta(options);
  const transport = server.transport;
  server.transport = (url, init = {}) => {
    const target = new URL(url);
    if (
      filterFromDate &&
      (init.method ?? 'GET') === 'GET' &&
      target.pathname === '/api/v1/charges'
    ) {
      const from = Date.parse(target.searchParams.get('fromDate'));
      const all = server.charges;
      server.charges = all.filter((c) => Date.parse(c.createdAt) >= from);
      try {
        return transport(url, init);
      } finally {
        server.charges = all;
      }
    }
    return transport(url, init);
  };
  return server;
}

export async function setup(
  t,
  { config = CONFIG, store = chainedStore(), server = montaServer(), now = NOW, logs = [] } = {},
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const gladys = createFakeGladys({ config });
  const make = () =>
    new MontaApp({
      gladys,
      logger: recorder(logs),
      transport: (url, init) => server.transport(url, init),
      now: () => Date.now(),
      store,
    });
  const app = make();
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
  if (gladys.fake.discoveredDevices.length > 0) {
    await gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]);
    await settle();
  }
  const ctx = { gladys, app, server, store, advance, logs };
  /** A new app on the same store and server (a restart of the container). */
  ctx.restart = async (cfg = config) => {
    ctx.app.stop();
    const again = make();
    t.after(() => again.stop());
    ctx.app = again;
    await again.start(cfg);
    await settle();
    return again;
  };
  return ctx;
}

const deviceOf = (gladys) => gladys.fake.discoveredDevices.at(-1);
const featureOf = (gladys, role) =>
  deviceOf(gladys).features.find((f) => f.external_id === feature(role));

/** A click through the app in use, the clock moved until the answer. */
export async function press(ctx, role, value = 1) {
  const pending = ctx.app
    .setValue(deviceOf(ctx.gladys), featureOf(ctx.gladys, role), value)
    .then(() => ({ success: true }))
    .catch((err) => ({ success: false, error: err?.message }));
  let ack;
  pending.then((a) => {
    ack = a;
  });
  for (let i = 0; i < 80 && ack === undefined; i += 1) {
    await ctx.advance(100, 100);
  }
  return ack;
}

export const message = (gladys) => gladys.fake.connectionStatus?.message ?? {};
export const last = (gladys, role) => gladys.fake.lastState(feature(role));
export const stops = (server) => server.routes().filter((r) => /^POST charges\/\d+\/stop$/.test(r));
export const starts = (server) => server.routes().filter((r) => r === 'POST charges');
