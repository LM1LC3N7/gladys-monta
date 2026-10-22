// -----------------------------------------------------------------------------
// Constants: the Monta public API (routes, states), the timings and the limits.
// The routes, the token exchange and the states are those of monta-python
// (MIT, see THIRD_PARTY_NOTICES.md) and of the public documentation of the
// API (https://docs.public-api.monta.com).
// -----------------------------------------------------------------------------

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const API_BASE = 'https://public-api.monta.com/api/v1/';

/** The routes used, relative to API_BASE. */
export const PATHS = {
  token: 'auth/token',
  refresh: 'auth/refresh',
  chargePoints: (page, perPage) => `charge-points?page=${page}&perPage=${perPage}`,
  chargePoint: (id) => `charge-points/${id}`,
  charges: ({ chargePointId, fromDate, page = 0, perPage }) =>
    `charges?${chargePointId === undefined ? '' : `chargePointId=${chargePointId}&`}` +
    `fromDate=${fromDate}&page=${page}&perPage=${perPage}`,
  start: 'charges',
  stop: (chargeId) => `charges/${chargeId}/stop`,
};

/** The configuration actions (manifest `actions`). */
export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** States of a charge point (`state` of the ChargePoint object). */
export const POINT_STATE = {
  AVAILABLE: 'available',
  BUSY: 'busy',
  BUSY_BLOCKED: 'busy-blocked',
  BUSY_CHARGING: 'busy-charging',
  BUSY_NON_CHARGING: 'busy-non-charging',
  BUSY_NON_RELEASED: 'busy-non-released',
  BUSY_RESERVED: 'busy-reserved',
  BUSY_SCHEDULED: 'busy-scheduled',
  ERROR: 'error',
  DISCONNECTED: 'disconnected',
  PASSIVE: 'passive',
  OTHER: 'other',
};

/** States of a charge (`state` of the Charge object). */
export const CHARGE_STATE = {
  RESERVED: 'reserved',
  STARTING: 'starting',
  CHARGING: 'charging',
  STOPPING: 'stopping',
  PAUSED: 'paused',
  SCHEDULED: 'scheduled',
  STOPPED: 'stopped',
  COMPLETED: 'completed',
};

/** A charge in one of these states is in progress: a stop applies to it. */
export const ACTIVE_CHARGE_STATES = new Set([
  CHARGE_STATE.RESERVED,
  CHARGE_STATE.STARTING,
  CHARGE_STATE.CHARGING,
  CHARGE_STATE.STOPPING,
  CHARGE_STATE.PAUSED,
  CHARGE_STATE.SCHEDULED,
]);

/** A charge in one of these states draws (or is about to draw) energy. */
export const DRAWING_CHARGE_STATES = new Set([CHARGE_STATE.STARTING, CHARGE_STATE.CHARGING]);

/** The value a `button/push` feature sends. */
export const PRESSED = 1;

/** Feature roles: the last part of the feature external ids, forever. */
export const FEATURES = {
  STATUS: 'status',
  CONNECTOR: 'connector-status',
  CHARGING_STATE: 'charging-state',
  PLUGGED: 'plugged',
  CHARGE_STATUS: 'charge-status',
  SESSION_ENERGY: 'session-energy',
  VEHICLE_BATTERY: 'vehicle-battery',
  METER: 'meter-reading',
  START: 'start-charge',
  STOP: 'stop-charge',
};

/** The poll interval (seconds): the manifest bounds and default. */
export const POLL_INTERVAL = { min: 60, max: 3600, default: 120 };

export const TIMINGS = {
  /** Timeout of one request (the transport's default). */
  requestTimeout: 10 * SECOND,
  /** The access token is renewed this long before its expiry. */
  tokenRenewMargin: 5 * MINUTE,
  /** Lifetime assumed when Monta sends no readable expiry (documented: 1 h, 30 days). */
  accessLifetime: HOUR,
  refreshLifetime: 30 * 24 * HOUR,
  /** 429: pause bounds and default (Monta counts requests in fixed 60 s blocks). */
  rateLimitMin: MINUTE,
  rateLimitDefault: MINUTE,
  rateLimitMax: 6 * HOUR,
  /** 5xx or no answer: the pauses after 1, 2, 3, 4+ failures (never under the interval). */
  backoff: [MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE],
  /** A persisted time read back from /data holds at most this long. */
  persistedMax: 24 * HOUR,
  /** The time of the last read attempt is written to /data at most once a minute. */
  attemptWriteEvery: MINUTE,
  /** Charges read back this far (fromDate): the charges in progress are among them. */
  chargesWindow: 7 * 24 * HOUR,
  /** A secondary endpoint refused with a 403 is skipped this long. */
  secondaryForbiddenSkip: HOUR,
  /** Gladys waits 5 s for a command: nothing is sent later than this after the click. */
  commandSendBy: 3500,
  /** Gladys is answered at the latest this long after the click. */
  commandAck: 4300,
  /** The least time a fresh read before a command needs. */
  commandMinRead: 700,
  /** The least time left to send a command. */
  commandMinSend: 300,
  /** Reads after a command (its effect), each one a full read. */
  followUp: 20 * SECOND,
  /** Two follow-up reads are at least this far apart. */
  followUpGap: MINUTE,
  /** A fresh read of a charge point's charges serves the stops this long. */
  freshReuse: 30 * SECOND,
  /** A watch after a stop whose resends fail lasts at most this long. */
  watchMax: 10 * MINUTE,
  /** A start not confirmed may still land: a stop sent within this window is reaffirmed. */
  guard: 90 * SECOND,
  /** A stop is reaffirmed at most this many times. */
  stopReasserts: 2,
  /** A read showing a charge again is trusted this long after the stop left (Monta at work). */
  stopSettle: 15 * SECOND,
  /** Flush of the states to Gladys. */
  flushInterval: SECOND,
  /** Unchanged states are sent again this often (publishChangedStates heartbeat). */
  stateHeartbeat: 30 * MINUTE,
};

export const LIMITS = {
  /** Largest answer read (bytes). */
  responseBytes: 1024 * 1024,
  /** Monta: 10 requests per minute for all the applications of a user. */
  requestsPerMinute: 10,
  /**
   * The requests a periodic read may take: a token, the pages of charge
   * points, the charges, and one new try after a refused token.
   */
  readNeed: 1 + 2 + 1 + 1,
  /** A periodic read starts only if this many more stay free (a stop: token, read, stop). */
  reservedForCommands: 3,
  /** A start: a token, two reads, the start and one new try after a refused token. */
  startNeed: 5,
  /** A stop's fresh read: a token, the read and the stop itself. */
  stopReadNeed: 3,
  /** Charge points per page, and pages read per cycle. */
  perPage: 100,
  pages: 2,
  /** Charges read per cycle (the most recent of the window). */
  chargesPerPage: 100,
  /** Charges read before a command, for one charge point (one request whatever the count). */
  commandCharges: 100,
  /** Devices published at most. */
  chargePoints: 50,
  /** Gladys: 300 states per minute, 100 per request. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** Longest text kept from Monta (names, models). */
  text: 80,
};
