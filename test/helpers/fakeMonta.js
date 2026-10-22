// -----------------------------------------------------------------------------
// A fake Monta public API behind the transport the integration is given,
// answering like monta-python expects (accessToken/refreshToken with their
// expiry dates, `Authorization: Bearer <token>`, `{ data, meta }` lists).
// Records every request. No network.
// -----------------------------------------------------------------------------

import { MontaError } from '../../src/monta.js';

export const CLIENT_ID = 'client-id-123';
export const CLIENT_SECRET = 'secret-abc-456';
export const POINT_ID = 4711;
export const SERIAL = 'SN-0001-SECRET-SERIAL';

const HOUR = 3600_000;

const answer = (status, body, headers = {}) => ({
  status,
  headers,
  body: body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body),
});

export const chargePoint = (overrides = {}) => ({
  id: POINT_ID,
  serialNumber: SERIAL,
  name: 'Garage',
  visibility: 'private',
  maxKw: 11,
  type: 'ac',
  state: 'busy-non-charging',
  cablePluggedIn: true,
  lastMeterReadingKwh: 1234.5,
  brandName: 'Easee',
  modelName: 'Home',
  firmwareVersion: '1.2.3',
  location: {
    coordinates: { latitude: 55.1, longitude: 12.2 },
    address: { address1: '1 Private Street', city: 'Town', zip: '1000', country: 'DK' },
  },
  connectors: [{ identifier: 'type2', name: 'Type 2' }],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-10-22T00:00:00Z',
  ...overrides,
});

export const charge = (overrides = {}) => ({
  id: 900,
  chargePointId: POINT_ID,
  humanReadableId: 'ABC',
  state: 'completed',
  consumedKwh: 12.345,
  soc: { percentage: 80, source: 'vehicle' },
  createdAt: '2026-10-21T00:00:00Z',
  updatedAt: '2026-10-21T02:00:00Z',
  ...overrides,
});

export function fakeMonta({ points = [chargePoint()], charges = [charge()] } = {}) {
  const server = {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    points,
    charges,
    nextChargeId: 1000,
    /** { method, path, query, json, token } */
    requests: [],
    accessTokens: new Set(),
    refreshTokens: new Set(),
    /** Every secret ever issued, to check none reaches the logs nor /data. */
    secrets: [CLIENT_SECRET],
    issued: 0,
    down: false,
    /** One-shot answers: { match(request), status, body, headers, wait, error } */
    queue: [],
    api() {
      return this.requests.filter((r) => !r.path.startsWith('/api/v1/auth/'));
    },
    tokens() {
      return this.requests.filter((r) => r.path.startsWith('/api/v1/auth/'));
    },
    commands() {
      return this.requests.filter(
        (r) => r.method === 'POST' && !r.path.startsWith('/api/v1/auth/'),
      );
    },
    routes() {
      return this.requests.map((r) => `${r.method} ${r.path.replace('/api/v1/', '')}`);
    },
    issue() {
      this.issued += 1;
      const accessToken = `access-${this.issued}-secret`;
      const refreshToken = `refresh-${this.issued}-secret`;
      this.accessTokens.add(accessToken);
      this.refreshTokens.add(refreshToken);
      this.secrets.push(accessToken, refreshToken);
      const now = Date.now();
      return {
        accessToken,
        accessTokenExpirationDate: new Date(now + HOUR).toISOString(),
        refreshToken,
        refreshTokenExpirationDate: new Date(now + 30 * 24 * HOUR).toISOString(),
        userId: 7,
      };
    },
    /** Hold the next request matching `match` until the returned function is called. */
    hold(match, then = {}) {
      let release;
      const wait = new Promise((resolve) => {
        release = resolve;
      });
      this.queue.push({ match, wait, ...then });
      return release;
    },
  };

  server.transport = async (url, { method = 'GET', headers = {}, body, onSent } = {}) => {
    const target = new URL(url);
    const request = {
      method,
      host: target.host,
      path: target.pathname,
      query: Object.fromEntries(target.searchParams),
      headers,
      json: body ? JSON.parse(body) : undefined,
      token: String(headers.Authorization ?? '').replace(/^Bearer /, '') || undefined,
    };
    server.requests.push(request);
    if (server.down) {
      throw new MontaError('network', 'connection refused', { notSent: true });
    }
    onSent?.();
    const forced = server.queue.findIndex((q) => q.match(request));
    if (forced >= 0) {
      const [entry] = server.queue.splice(forced, 1);
      if (entry.wait) {
        await entry.wait;
      }
      if (entry.error) {
        throw entry.error;
      }
      if (entry.status !== undefined) {
        return answer(entry.status, entry.body, entry.headers);
      }
    }
    const route = `${method} ${request.path.replace('/api/v1/', '')}`;
    if (route === 'POST auth/token') {
      const { clientId, clientSecret } = request.json ?? {};
      if (clientId !== server.clientId || clientSecret !== server.clientSecret) {
        return answer(401, {
          status: 'UNAUTHORIZED',
          message: `Application with given clientId ${clientId} not found`,
          errorCode: 'APPLICATION_NOT_FOUND',
        });
      }
      return answer(200, server.issue());
    }
    if (route === 'POST auth/refresh') {
      const { refreshToken } = request.json ?? {};
      if (!server.refreshTokens.has(refreshToken)) {
        return answer(401, { status: 'UNAUTHORIZED', errorCode: 'INVALID_REFRESH_TOKEN' });
      }
      server.refreshTokens.delete(refreshToken);
      return answer(200, server.issue());
    }
    if (!server.accessTokens.has(request.token)) {
      return answer(401, { status: 'UNAUTHORIZED', errorCode: 'INVALID_ACCESS_TOKEN' });
    }
    if (route === 'GET charge-points') {
      return answer(200, {
        data: server.points,
        meta: { currentPage: 0, perPage: 100, totalPageCount: 1, itemCount: server.points.length },
      });
    }
    const point = /^GET charge-points\/(\d+)$/.exec(route);
    if (point) {
      const found = server.points.find((p) => p.id === Number(point[1]));
      return found ? answer(200, found) : answer(404, { errorCode: 'RESOURCE_NOT_FOUND' });
    }
    if (route === 'GET charges') {
      const id = request.query.chargePointId;
      const data = server.charges.filter((c) => id === undefined || c.chargePointId === Number(id));
      return answer(200, { data, meta: { totalPageCount: 1 } });
    }
    if (route === 'POST charges') {
      const created = charge({
        id: server.nextChargeId++,
        chargePointId: request.json.chargePointId,
        state: 'starting',
        consumedKwh: 0,
      });
      server.charges.push(created);
      return answer(200, created);
    }
    const stop = /^POST charges\/(\d+)\/stop$/.exec(route);
    if (stop) {
      const found = server.charges.find((c) => c.id === Number(stop[1]));
      if (!found) {
        return answer(404, { errorCode: 'RESOURCE_NOT_FOUND' });
      }
      found.state = 'stopped';
      return answer(200, found);
    }
    return answer(404, { errorCode: 'RESOURCE_NOT_FOUND' });
  };

  return server;
}

/** An in-memory store, in place of the /data file. */
export function memoryStore(initial = null) {
  return {
    data: initial,
    saves: 0,
    async load() {
      return this.data === null ? null : structuredClone(this.data);
    },
    async save(data) {
      this.saves += 1;
      this.data = structuredClone(data);
    },
  };
}

/** Lets the pending promises settle (no timer involved). */
export const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};
