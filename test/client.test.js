import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Limiter, MontaClient, tokensOf } from '../src/client.js';
import { HOUR, MINUTE, TIMINGS } from '../src/constants.js';
import { answerError, parseRetryAfter } from '../src/monta.js';
import { CLIENT_ID, CLIENT_SECRET, fakeMonta } from './helpers/fakeMonta.js';

const client = (server, now = () => Date.now()) =>
  new MontaClient({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    transport: server.transport,
    now,
  });

test('a refused access token is replaced once, a refused refresh token falls back once', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-22T10:00:00Z') });
  const server = fakeMonta();
  const c = client(server);
  await c.chargePoints();
  assert.deepEqual(server.routes(), ['POST auth/token', 'GET charge-points']);

  // Revoked access token: one refresh, one new try.
  server.accessTokens.clear();
  await c.chargePoints();
  assert.deepEqual(server.routes().slice(2), [
    'GET charge-points',
    'POST auth/refresh',
    'GET charge-points',
  ]);

  // Both revoked: the refresh is refused, the client credentials once.
  server.accessTokens.clear();
  server.refreshTokens.clear();
  c.beginCycle();
  await c.chargePoints();
  assert.deepEqual(server.routes().slice(5), [
    'GET charge-points',
    'POST auth/refresh',
    'POST auth/token',
    'GET charge-points',
  ]);

  // Refused again in the same cycle: no loop, an error.
  server.accessTokens.clear();
  server.refreshTokens.clear();
  await assert.rejects(c.chargePoints(), (err) => err.kind === 'unauthorized');
  const count = server.requests.length;
  assert.ok(count - 9 <= 3, 'at most one refresh and one token per cycle');
});

test('refused credentials are final (refused), never retried in the same call', async () => {
  const server = fakeMonta();
  server.clientSecret = 'other';
  const c = client(server);
  await assert.rejects(c.chargePoints(), (err) => err.kind === 'refused');
  assert.deepEqual(server.routes(), ['POST auth/token']);
});

test('the token is renewed before its expiry, never trusted beyond an hour', () => {
  const now = Date.parse('2026-10-22T10:00:00Z');
  const tokens = tokensOf(
    {
      accessToken: 'a',
      refreshToken: 'r',
      accessTokenExpirationDate: '2027-01-01T00:00:00Z',
      refreshTokenExpirationDate: 'garbage',
    },
    now,
  );
  assert.equal(tokens.accessRenewAt, now + HOUR - TIMINGS.tokenRenewMargin);
  assert.equal(tokens.refreshRenewAt, now + TIMINGS.refreshLifetime - TIMINGS.tokenRenewMargin);
  assert.throws(() => tokensOf({ accessToken: '' }, now));
});

test('joining a token renewal never waits past the deadline of the caller', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const c = client(fakeMonta());
  let release;
  c.authenticating = new Promise((resolve) => {
    release = resolve;
  });
  const joined = c.accessToken({ deadline: 3000 }).then(
    () => 'ok',
    (err) => err,
  );
  t.mock.timers.tick(3000);
  const err = await joined;
  assert.equal(err.kind, 'timeout');
  assert.equal(err.notSent, true);
  release();
});

test('the limiter: 10 requests in any minute', () => {
  let now = 0;
  const limiter = new Limiter(() => now);
  for (let i = 0; i < 8; i += 1) {
    limiter.note();
    now += 1000;
  }
  assert.equal(limiter.room(), 2);
  assert.equal(limiter.waitFor(2), 0);
  assert.equal(limiter.waitFor(4), MINUTE - 8000 + 1000);
  now = MINUTE + 500;
  assert.equal(limiter.room(), 3);
});

test('errors: statuses mapped, no free text kept, Retry-After read', () => {
  const body = JSON.stringify({ message: 'secret free text', errorCode: 'APPLICATION_NOT_FOUND' });
  const refused = answerError({ status: 401, body }, { step: 'token' });
  assert.equal(refused.kind, 'refused');
  assert.equal(refused.code, 'APPLICATION_NOT_FOUND');
  assert.ok(!refused.message.includes('free text'));
  assert.equal(answerError({ status: 403, body: '' }).kind, 'forbidden');
  assert.equal(answerError({ status: 400, body: '' }, { step: 'token' }).kind, 'login_rejected');
  assert.equal(answerError({ status: 503, body: '' }, { step: 'token' }).kind, 'unavailable');
  const limited = answerError({ status: 429, headers: { 'retry-after': '30' }, body: '' });
  assert.equal(limited.retryAfter, 30_000);
  assert.equal(parseRetryAfter('nonsense'), undefined);
  assert.equal(answerError({ status: 204, body: '' }), undefined);
});
