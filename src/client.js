// -----------------------------------------------------------------------------
// The Monta account: the access token got from the client id and secret
// (`auth/token`), renewed from the refresh token before it expires
// (`auth/refresh`), a refused refresh token falling back to the client
// credentials once (as monta-python does); the calls the integration makes,
// and the count of requests against the limit of Monta (10 per minute).
//
// The tokens live in memory only: never in /data, never in a log. A new
// client is made for each start, so a late answer of an old configuration
// never touches the tokens of the new one. Ported from monta-python (MIT).
// -----------------------------------------------------------------------------

import { API_BASE, LIMITS, MINUTE, PATHS, TIMINGS } from './constants.js';
import { MontaError, answerError, httpRequest, parseJson } from './monta.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The requests sent in the last minute, shared by every client of the app (a
 * restart of the client never forgets them). Monta counts 10 requests per
 * fixed minute for all the applications of a user: at most 10 in any 60 s
 * here is at most 10 in any of its blocks.
 */
export class Limiter {
  constructor(now = Date.now) {
    this.now = now;
    this.times = [];
  }

  prune() {
    const now = this.now();
    while (this.times.length > 0 && now - this.times[0] >= MINUTE) {
      this.times.shift();
    }
  }

  /** The requests still free in the current minute. */
  room() {
    this.prune();
    return Math.max(0, LIMITS.requestsPerMinute - this.times.length);
  }

  /** When `count` requests will be free (ms from now, 0 when they are). */
  waitFor(count) {
    this.prune();
    const over = this.times.length + count - LIMITS.requestsPerMinute;
    if (over <= 0) {
      return 0;
    }
    return Math.max(0, this.times[over - 1] + MINUTE - this.now());
  }

  note() {
    this.times.push(this.now());
  }

  /** The times of the last minute (persisted with the state). */
  recent() {
    this.prune();
    return [...this.times];
  }

  /**
   * The times persisted before a restart of the container (bounded, never in
   * the future). A limiter that already counts requests (a new configuration
   * in the same process) keeps its own: they are the same requests.
   */
  restore(times) {
    if (this.times.length > 0) {
      return;
    }
    const now = this.now();
    this.times = (Array.isArray(times) ? times : [])
      .filter((t) => Number.isFinite(t) && t <= now && now - t < MINUTE)
      .slice(-LIMITS.requestsPerMinute)
      .sort((a, b) => a - b);
  }
}

/** A date of Monta (ISO 8601) -> ms, or `fallback` when unreadable. */
const dateOr = (value, fallback) => {
  const t = typeof value === 'string' && value.length <= 64 ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : fallback;
};

/** A token answer -> the tokens kept in memory. */
export function tokensOf(json, now) {
  if (
    !isObject(json) ||
    typeof json.accessToken !== 'string' ||
    json.accessToken === '' ||
    json.accessToken.length > 8192 ||
    typeof json.refreshToken !== 'string' ||
    json.refreshToken.length > 8192
  ) {
    throw new MontaError('bad_response', 'Monta sent no token');
  }
  // An expiry already (nearly) past says the clocks disagree, not that the
  // token is dead: the documented lifetime then (never a renewal per request).
  const expiry = (value, lifetime) => {
    const at = dateOr(value, now + lifetime);
    return at - now > 2 * TIMINGS.tokenRenewMargin ? at : now + lifetime;
  };
  const accessExpiresAt = expiry(json.accessTokenExpirationDate, TIMINGS.accessLifetime);
  const refreshExpiresAt = expiry(json.refreshTokenExpirationDate, TIMINGS.refreshLifetime);
  return {
    accessToken: json.accessToken,
    refreshToken: json.refreshToken,
    // Never trusted beyond the documented lifetimes, whatever the clocks say.
    accessRenewAt:
      Math.min(accessExpiresAt, now + TIMINGS.accessLifetime) - TIMINGS.tokenRenewMargin,
    refreshRenewAt:
      Math.min(refreshExpiresAt, now + TIMINGS.refreshLifetime) - TIMINGS.tokenRenewMargin,
  };
}

export class MontaClient {
  constructor({
    clientId = '',
    clientSecret = '',
    transport = httpRequest,
    now = Date.now,
    limiter = new Limiter(now),
  } = {}) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.transport = transport;
    this.now = now;
    this.limiter = limiter;
    /** { accessToken, refreshToken, accessRenewAt, refreshRenewAt } | null */
    this.tokens = null;
    /** One token request at a time. */
    this.authenticating = undefined;
    /** One request with the client credentials per cycle at most (beginCycle resets it). */
    this.loggedIn = false;
    /** Bumped each time the tokens are replaced. */
    this.tokenGeneration = 0;
  }

  get hasCredentials() {
    return this.clientId !== '' && this.clientSecret !== '';
  }

  beginCycle() {
    this.loggedIn = false;
  }

  /** The timeout of a request that must be answered before `deadline` (if any). */
  timeoutFor(deadline) {
    if (deadline === undefined) {
      return TIMINGS.requestTimeout;
    }
    const left = deadline - this.now();
    if (left < TIMINGS.commandMinSend) {
      throw new MontaError('timeout', 'no time left to send the request', { notSent: true });
    }
    return Math.min(TIMINGS.requestTimeout, left);
  }

  /** One request, counted against the limit; resolves the parsed JSON. */
  async send(method, path, { payload, token, step = 'api', deadline, timeout, onSent } = {}) {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const headers = { Accept: 'application/json' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json; charset=UTF-8';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const wait = timeout ?? this.timeoutFor(deadline);
    this.limiter.note();
    const answer = await this.transport(`${API_BASE}${path}`, {
      method,
      headers,
      body,
      timeout: wait,
      onSent,
    });
    const error = answerError(answer, { step, now: this.now() });
    if (error) {
      throw error;
    }
    return parseJson(answer.body);
  }

  /** One token request at a time: a second caller joins the running one. */
  authenticate(fn) {
    if (!this.authenticating) {
      this.authenticating = fn().finally(() => {
        this.authenticating = undefined;
      });
    }
    return this.authenticating;
  }

  keep(json) {
    this.tokens = tokensOf(json, this.now());
    this.tokenGeneration += 1;
    return this.tokens;
  }

  /**
   * The client credentials -> new tokens (monta-python's async_request_token).
   * `login`: 'cycle' (once per read cycle), 'once' (a command: its own single
   * try) or 'never' (the credentials were refused: never sent again by a
   * command).
   */
  async login(deadline, login = 'cycle') {
    if (!this.hasCredentials) {
      throw new MontaError('no_credentials', 'no client id or secret');
    }
    if (login === 'never') {
      throw new MontaError('refused', 'credentials refused before, not sent again');
    }
    if (this.loggedIn && login !== 'once') {
      // Never asked twice in a cycle: a token refused right after it was got
      // says something is wrong, not that a new one would do.
      throw new MontaError('unauthorized', 'a new token was refused in this cycle');
    }
    this.loggedIn = true;
    const json = await this.send('POST', PATHS.token, {
      payload: { clientId: this.clientId, clientSecret: this.clientSecret },
      step: 'token',
      deadline,
    });
    return this.keep(json);
  }

  /** The refresh token -> new tokens; refused, the client credentials once. */
  async renew(deadline, login) {
    const refreshToken = this.tokens?.refreshToken;
    if (refreshToken && this.now() < this.tokens.refreshRenewAt) {
      try {
        const json = await this.send('POST', PATHS.refresh, {
          payload: { refreshToken },
          step: 'refresh',
          deadline,
        });
        return this.keep(json);
      } catch (err) {
        if (err.kind !== 'refresh_refused') {
          throw err;
        }
        this.tokens = null;
      }
    }
    return this.login(deadline, login);
  }

  /** A usable access token (renewed when due). */
  async accessToken({ deadline, login } = {}) {
    if (this.authenticating) {
      // Joined: its failure is this caller's too (never a second request at
      // once), and a caller with a deadline never waits past it.
      await this.joinWithin(this.authenticating, deadline);
    }
    if (this.tokens && this.now() < this.tokens.accessRenewAt) {
      return this.tokens.accessToken;
    }
    const tokens = await this.authenticate(() => this.renew(deadline, login));
    return tokens.accessToken;
  }

  /** Waits for `promise`, at most until `deadline` (then a `notSent` timeout). */
  async joinWithin(promise, deadline) {
    if (deadline === undefined) {
      return promise;
    }
    let timer;
    const late = new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new MontaError('timeout', 'a token renewal still running at the deadline', {
              notSent: true,
            }),
          ),
        Math.max(0, deadline - this.now()),
      );
    });
    try {
      return await Promise.race([promise, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The access token was refused: it is dropped (not the refresh token). */
  discard(generation) {
    if (this.tokens && generation === this.tokenGeneration) {
      this.tokens = { ...this.tokens, accessRenewAt: 0 };
    }
  }

  /**
   * An authenticated request. A refused access token (401) is replaced and
   * the request sent once more (Monta refused it before acting on it, so even
   * a command is safe to send again), within the deadline. `beforeSend` runs
   * right before each sending (a command checks its option there); it throws
   * to cancel.
   *
   * `deadline`: the answer is due by then (a read). `sendBy`: the request
   * must leave by then, its answer may come later (a command).
   *
   * Whatever fails before the request itself leaves (the token, `beforeSend`,
   * the deadline) is `notSent`: nothing reached Monta.
   */
  async request(method, path, { payload, deadline, sendBy, beforeSend, onSent, login } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      let token;
      let generation;
      try {
        token = await this.accessToken({ deadline: sendBy ?? deadline, login });
        generation = this.tokenGeneration;
        beforeSend?.();
        if (sendBy !== undefined && sendBy - this.now() < TIMINGS.commandMinSend) {
          throw new MontaError('timeout', 'no time left to send the command', { notSent: true });
        }
      } catch (err) {
        if (err instanceof MontaError) {
          err.notSent = true;
        }
        throw err;
      }
      try {
        return await this.send(method, path, {
          payload,
          token,
          deadline: sendBy === undefined ? deadline : undefined,
          onSent,
        });
      } catch (err) {
        if (err.kind !== 'unauthorized' || attempt > 0) {
          throw err;
        }
        this.discard(generation);
      }
    }
  }

  // --- Calls ---------------------------------------------------------------------

  /** The charge points of the account (pages bounded), those with a serial number. */
  async chargePoints(options) {
    const items = [];
    let truncated = false;
    for (let page = 0; page < LIMITS.pages; page += 1) {
      const json = await this.request('GET', PATHS.chargePoints(page, LIMITS.perPage), options);
      if (!isObject(json) || !Array.isArray(json.data)) {
        throw new MontaError('bad_response', 'Monta sent no charge point list');
      }
      items.push(...json.data.slice(0, LIMITS.perPage));
      const pages = Number(json.meta?.totalPageCount);
      if (!Number.isInteger(pages) || page + 1 >= pages || json.data.length === 0) {
        break;
      }
      if (page + 1 >= LIMITS.pages) {
        truncated = true;
      }
    }
    return { items, truncated };
  }

  /** One charge point. */
  async chargePoint(id, options) {
    const json = await this.request('GET', PATHS.chargePoint(id), options);
    if (!isObject(json)) {
      throw new MontaError('bad_response', 'Monta sent no charge point');
    }
    return json;
  }

  /** The charges created since `from` (ms), of one charge point or all of them. */
  async charges({ chargePointId, from, perPage = LIMITS.chargesPerPage }, options) {
    const fromDate = new Date(from).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const json = await this.request(
      'GET',
      PATHS.charges({ chargePointId, fromDate, perPage }),
      options,
    );
    if (!isObject(json) || !Array.isArray(json.data)) {
      throw new MontaError('bad_response', 'Monta sent no charge list');
    }
    return json.data.slice(0, perPage);
  }

  /** Starts a charge; resolves the Charge Monta created. */
  start(chargePointId, options) {
    return this.request('POST', PATHS.start, { ...options, payload: { chargePointId } });
  }

  /** Stops a charge; resolves the Charge. */
  stop(chargeId, options) {
    return this.request('POST', PATHS.stop(chargeId), options);
  }
}
