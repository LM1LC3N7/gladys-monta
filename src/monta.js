// -----------------------------------------------------------------------------
// The only network access: HTTPS requests to the Monta public API, and the
// errors they end with. Pure helpers for the answers.
//
// monta-python (MIT) is the reference: JSON bodies, `Authorization: Bearer
// <accessToken>`, 401 = the token (or the client credentials) refused, 403 =
// the request refused (a scope the application lacks), 429 with a
// `Retry-After` in seconds.
// -----------------------------------------------------------------------------

import https from 'node:https';
import { LIMITS, TIMINGS } from './constants.js';

/**
 * A failed call. `kind`:
 * - `no_credentials`: no client id or secret (never sent);
 * - `refused`: Monta refused the client id and secret (401 on auth/token);
 * - `login_rejected`: the token request itself was rejected (another 4xx);
 * - `refresh_refused`: the refresh token was refused;
 * - `unauthorized`: the API refused the access token (401);
 * - `forbidden`: a 403 (a scope the application lacks);
 * - `rate_limited`: 429, `retryAfter` in ms;
 * - `unavailable`: 5xx;
 * - `network`, `timeout`: no answer; `notSent` tells the request never left;
 * - `bad_response`, `size`: an answer that is not the expected JSON;
 * - `http`: any other status (400, 404...).
 * The message never holds a secret nor any free text of the answer: only the
 * short upper-case `errorCode` of Monta when it has one.
 */
export class MontaError extends Error {
  constructor(kind, message, { status, retryAfter, code, notSent } = {}) {
    super(message);
    this.name = 'MontaError';
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
    this.code = code;
    this.notSent = Boolean(notSent);
  }
}

const NETWORK_REASONS = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  ENOTFOUND: 'unknown host name',
  EAI_AGAIN: 'host name not resolved',
  ETIMEDOUT: 'connection timed out',
  EPIPE: 'connection closed',
};

/** A socket error -> MontaError (never the request: the token request carries the secret). */
export function networkError(err, notSent = false) {
  if (err instanceof MontaError) {
    return err;
  }
  const code = typeof err?.code === 'string' && /^[A-Z_]{1,32}$/.test(err.code) ? err.code : '';
  return new MontaError('network', NETWORK_REASONS[code] ?? (code || 'network error'), {
    notSent,
  });
}

/** A short, secret-free reason for a log or a status message. */
export function errorReason(err) {
  if (err instanceof MontaError) {
    const details = [err.code, err.status ? `HTTP ${err.status}` : undefined].filter(Boolean);
    return details.length > 0 ? `${err.message} (${details.join(', ')})` : err.message;
  }
  return 'internal error';
}

/**
 * One HTTPS request; resolves `{ status, headers, body }` whatever the status.
 * The promise settles once; the body read is bounded (chunks kept in a list,
 * joined once). `onSent` is called once the request has fully left.
 */
export function httpRequest(
  url,
  {
    method = 'GET',
    headers = {},
    body,
    timeout = TIMINGS.requestTimeout,
    maxBytes = LIMITS.responseBytes,
    onSent,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== 'https:') {
      reject(new MontaError('network', 'only HTTPS is used', { notSent: true }));
      return;
    }
    let timer;
    let settled = false;
    let sent = false;
    const settle = (fn, value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn(value);
      }
    };
    const req = https.request(target, { method, headers }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          settle(reject, new MontaError('size', 'answer too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () =>
        settle(resolve, {
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      res.on('error', (err) => settle(reject, networkError(err)));
    });
    req.on('finish', () => {
      sent = true;
      onSent?.();
    });
    timer = setTimeout(() => {
      settle(
        reject,
        new MontaError('timeout', `no answer within ${Math.round(timeout / 1000)} s`, {
          notSent: !sent,
        }),
      );
      req.destroy();
    }, timeout);
    req.on('error', (err) => settle(reject, networkError(err, !sent)));
    req.end(body);
  });
}

/** Retry-After (seconds or an HTTP date) -> milliseconds, undefined when absent. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** The JSON of a body; `undefined` for an empty body. */
export function parseJson(body) {
  if (body === undefined || body === null || String(body).trim() === '') {
    return undefined;
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new MontaError('bad_response', 'an answer that is not JSON');
  }
}

/** The `errorCode` of a Monta error body (upper case only, never the free text). */
export function montaCode(body) {
  let json;
  try {
    json = parseJson(body);
  } catch {
    return undefined;
  }
  const code = json && typeof json === 'object' ? json.errorCode : undefined;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : undefined;
}

/**
 * The error of an answer, or undefined when it is a success. `step`: 'token'
 * (client credentials), 'refresh' (refresh token) or 'api'.
 */
export function answerError({ status, headers = {}, body }, { step = 'api', now } = {}) {
  if (status >= 200 && status < 300) {
    return undefined;
  }
  const code = montaCode(body);
  if (status === 429) {
    return new MontaError('rate_limited', 'too many requests', {
      status,
      code,
      retryAfter: parseRetryAfter(headers['retry-after'], now),
    });
  }
  if (status >= 500) {
    return new MontaError('unavailable', 'Monta is unavailable', { status, code });
  }
  if (step === 'token') {
    return status === 401
      ? new MontaError('refused', 'client id or secret refused', { status, code })
      : new MontaError('login_rejected', 'token request rejected', { status, code });
  }
  if (step === 'refresh') {
    return new MontaError('refresh_refused', 'refresh token refused', { status, code });
  }
  if (status === 401) {
    return new MontaError('unauthorized', 'token refused', { status, code });
  }
  if (status === 403) {
    return new MontaError('forbidden', 'request not permitted', { status, code });
  }
  return new MontaError('http', 'request failed', { status, code });
}
