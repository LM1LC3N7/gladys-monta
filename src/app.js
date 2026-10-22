// -----------------------------------------------------------------------------
// The integration: the Monta application (client id and secret), one read per
// interval (the charge points, then their recent charges), the Gladys devices
// and their states, the transport badges, the "Test the connection" button,
// and the two commands: starting a charge (refused unless the configuration
// allows it) and stopping it (always possible, never held back by a pause).
// index.js only wires the SDK handlers to it.
//
// Monta allows 10 requests per minute for all the applications of a user: a
// read takes two (three when the token is renewed) and starts only when four
// stay free for the commands.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { Limiter, MontaClient } from './client.js';
import { normalizeConfig } from './config.js';
import {
  CHARGE_STATE,
  DRAWING_CHARGE_STATES,
  FEATURES,
  LIMITS,
  MINUTE,
  POINT_STATE,
  PRESSED,
  TIMINGS,
} from './constants.js';
import { COMMAND_ROLES, buildDevice, deviceStates, parseFeatureId, pointIds } from './devices.js';
import { CHARGE_STATE_NAMES, ERRORS, POINT_STATE_NAMES, T, age, join, word } from './i18n.js';
import {
  activeCharge,
  currentCharges,
  isActive,
  readChargePoint,
  readChargePoints,
  readCharge,
} from './model.js';
import { MontaError, errorReason } from './monta.js';
import { StatePublisher } from './publisher.js';
import { fileStore, fingerprint, newSalt, normalizeMemory } from './store.js';

/** Errors after which Monta counts as unreachable (badge). */
const OFFLINE = new Set(['network', 'timeout', 'unavailable', 'bad_response', 'size']);
/** Errors that stop the reads for good (no automatic try). */
const FINAL = new Set(['refused', 'login_rejected', 'forbidden']);
/** Charge point states in which a start is refused at once. */
const NOT_READY = new Set([
  POINT_STATE.DISCONNECTED,
  POINT_STATE.ERROR,
  POINT_STATE.PASSIVE,
  POINT_STATE.OTHER,
  POINT_STATE.BUSY_RESERVED,
  POINT_STATE.BUSY_BLOCKED,
  'unknown',
]);
/** Charge states that confirm a stop. */
const STOPPED = new Set([CHARGE_STATE.STOPPED, CHARGE_STATE.COMPLETED]);

/** A refusal decided here (never sent): its message is shown as is. */
class Refusal extends Error {}

export class MontaApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'monta' }),
    transport,
    now = Date.now,
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.transport = transport;
    this.now = now;
    this.timers = timers;
    this.store = store;
    this.limiter = new Limiter(now);
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.client = this.newClient();
    this.memory = normalizeMemory(null, now());
    this.generation = 0;
    this.timer = undefined;
    this.followTimer = undefined;
    this.running = undefined;
    this.started = false;
    this.lastStatus = undefined;
    this.attemptWrittenAt = -Infinity;
    /** 'rate' (429) or 'server' (5xx, no answer): every read waits; a stop never does. */
    this.pausedUntil = 0;
    this.pauseKind = undefined;
    /** Commands in flight, per charge point: start -> entry, stop -> entry. */
    this.starts = new Map();
    this.stops = new Map();
    /** Stop clicks per charge point: a start checks that none arrived before sending. */
    this.stopSeq = new Map();
    /** When the last start left, per charge point. */
    this.startSentAt = new Map();
    /** A start not confirmed may still land until then, per charge point. */
    this.unconfirmedUntil = new Map();
    /** The watch after a stop, per charge point (see watch()). */
    this.watches = new Map();
    this.reset();
  }

  newClient() {
    return new MontaClient({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      transport: this.transport,
      now: this.now,
      limiter: this.limiter,
    });
  }

  /** Forgets what was read: a new account, or a restart. A 429/5xx pause stays. */
  reset() {
    /** id -> { point, charge } of the last read. */
    this.points = new Map();
    /** id -> id of its charge in progress (or null): from the reads, or /data before the first. */
    this.known = new Map();
    this.readOnce = false;
    this.offline = false;
    this.failures = 0;
    this.block = undefined;
    this.tryBlocked = false;
    this.published = undefined;
    this.badges = undefined;
    this.skipChargesUntil = 0;
    this.warned = new Set();
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * `newCredentials`: saved by the user, they are tried at once (one try per
   * save); a restart or anything else waits for the interval since the last
   * attempt kept in /data.
   */
  async start(raw = {}, { newCredentials = false } = {}) {
    // A read under way is not awaited: its late answer is dropped (generation).
    this.stop();
    this.config = normalizeConfig(raw);
    this.client = this.newClient();
    this.reset();
    this.immediate = newCredentials;
    const generation = this.generation;
    this.memory = normalizeMemory(await this.store.load().catch(() => null), this.now());
    if (generation !== this.generation) {
      return;
    }
    const { account, clientId, clientSecret } = this.config;
    // A 429 or 5xx pause survives a restart and a change of account.
    const pause = this.memory.pause;
    if (pause && pause.until > this.now()) {
      this.pausedUntil = pause.until;
      this.pauseKind = pause.kind;
    }
    // A stop holds only for the very credentials that were refused.
    const block = this.memory.block;
    if (block) {
      if (
        block.account === account &&
        fingerprint(block.salt, clientId, clientSecret) === block.fingerprint
      ) {
        this.block = block;
      } else {
        this.memory.block = null;
        await this.saveMemory();
      }
    }
    if (this.memory.points?.account === account) {
      for (const { id, charge } of this.memory.points.list) {
        this.known.set(id, charge);
      }
    }
    this.publisher.start();
    if (!this.client.hasCredentials) {
      await this.setStatus(false, T.noCredentials);
      return;
    }
    if (this.block) {
      await this.setStatus(false, this.blockMessage());
      return;
    }
    const wait = this.nextReadIn();
    await this.setStatus(
      false,
      this.pauseMessage() ?? (wait > 0 ? T.waiting(age(wait)) : T.connecting),
    );
    this.scheduleNext();
  }

  stop() {
    this.generation += 1;
    this.clearTimer();
    if (this.followTimer) {
      this.timers.clearTimeout(this.followTimer);
      this.followTimer = undefined;
    }
    this.publisher.stop();
  }

  clearTimer() {
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection (Gladys
   * restarted), resend what Gladys keeps in memory only (status, Discovery
   * list, badges) and the last states. Never a read: the pauses, the stops
   * and the time of the last read stay.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.configUpdated(raw);
    this.published = undefined;
    this.badges = undefined;
    const status = this.lastStatus;
    this.lastStatus = undefined;
    if (status) {
      const [connected, message] = JSON.parse(status);
      await this.setStatus(connected, message ?? undefined);
    }
    await this.publishDevices();
    this.queueStates();
    await this.flush();
    await this.publishBadges();
  }

  /** New credentials restart; a new interval reschedules; a new language renames. */
  async configUpdated(raw = {}) {
    const next = normalizeConfig(raw);
    const previous = this.config;
    if (next.clientId !== previous.clientId || next.clientSecret !== previous.clientSecret) {
      return this.start(raw, { newCredentials: true });
    }
    this.config = next;
    if (next.interval !== previous.interval && !this.running) {
      this.scheduleNext();
    }
    if (next.language !== previous.language) {
      this.published = undefined;
      await this.publishDevices();
      this.queueStates();
      await this.flush();
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  /** The message of the last status (multi-language), or undefined. */
  get lastMessage() {
    return JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? undefined;
  }

  async saveMemory() {
    await this.store
      .save(this.memory)
      .catch((err) => this.logger.warn(`Saving the state to /data failed: ${err.message}`));
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  // --- Reads -----------------------------------------------------------------

  get paused() {
    return this.now() < this.pausedUntil;
  }

  /** How long until the next periodic read may start (0: now). */
  nextReadIn() {
    const now = this.now();
    const last = this.immediate ? -Infinity : (this.memory.lastAttemptAt ?? -Infinity);
    const earliest = Math.max(this.pausedUntil, last + this.config.interval);
    return Math.max(0, earliest - now);
  }

  /** The next periodic read: never sooner than the interval since the last attempt. */
  scheduleNext() {
    this.clearTimer();
    if (!this.client.hasCredentials || this.block) {
      return;
    }
    const generation = this.generation;
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      if (generation === this.generation) {
        this.tick().catch(() => this.logger.error('Monta refresh failed'));
      }
    }, this.nextReadIn());
  }

  /** One read at a time: a tick during a read joins it (a reconnection never starts another). */
  tick({ followUp = false } = {}) {
    if (this.running && this.runningGeneration === this.generation) {
      return this.running;
    }
    // A read of an old configuration still under way: it publishes nothing
    // (generation), and the new one starts after it (one read at a time).
    const previous = this.running ?? Promise.resolve();
    const running = previous
      .catch(() => {})
      .then(() => this.run({ followUp }))
      .finally(() => {
        if (this.running === running) {
          this.running = undefined;
        }
      });
    this.running = running;
    this.runningGeneration = this.generation;
    return running;
  }

  /** The time of the attempt, in /data BEFORE the read (at most once a minute). */
  async noteAttempt() {
    const now = this.now();
    this.memory.lastAttemptAt = now;
    if (now - this.attemptWrittenAt >= TIMINGS.attemptWriteEvery) {
      this.attemptWrittenAt = now;
      await this.saveMemory();
    }
  }

  async run({ followUp = false } = {}) {
    const generation = this.generation;
    if (!this.client.hasCredentials || (this.block && !this.tryBlocked)) {
      return;
    }
    if (this.paused || (!followUp && this.nextReadIn() > 0)) {
      this.scheduleNext();
      return;
    }
    // Room for the read (the token, the charge points, the charges) and the commands.
    const need = 3 + LIMITS.reservedForCommands;
    const wait = this.limiter.waitFor(need);
    if (wait > 0) {
      this.clearTimer();
      this.timer = this.timers.setTimeout(() => {
        this.timer = undefined;
        if (generation === this.generation) {
          this.tick({ followUp }).catch(() => this.logger.error('Monta refresh failed'));
        }
      }, wait);
      return;
    }
    this.client.beginCycle();
    this.immediate = false;
    await this.noteAttempt();
    if (generation !== this.generation) {
      return;
    }
    const client = this.client;
    try {
      const { items, truncated } = await client.chargePoints();
      if (generation !== this.generation) {
        return;
      }
      const { points, dropped } = readChargePoints(items);
      this.warnOnce('truncated', truncated, 'Monta: more charge points than read in one cycle');
      this.warnOnce('dropped', dropped > 0, `Monta: ${dropped} item(s) of the list ignored`);
      this.warnOnce(
        'capped',
        points.size >= LIMITS.chargePoints,
        `Monta: only the first ${LIMITS.chargePoints} charge points are shown`,
      );
      // Secondary: the charges. Never a stop: the charge points are shown anyway.
      let charges;
      let held;
      if (points.size > 0 && this.now() >= this.skipChargesUntil) {
        try {
          charges = currentCharges(
            await client.charges({ from: this.now() - TIMINGS.chargesWindow }),
          );
        } catch (err) {
          this.logger.info(`Monta charges not read: ${errorReason(err)}`);
          if (err.kind === 'forbidden') {
            this.skipChargesUntil = this.now() + TIMINGS.secondaryForbiddenSkip;
          }
          if (err.kind === 'rate_limited' || err.kind === 'unavailable') {
            held = err;
          }
        }
      }
      if (generation !== this.generation) {
        return;
      }
      await this.apply(points, charges);
      if (generation !== this.generation) {
        return;
      }
      await this.succeeded(points.size, points.size > 0 && charges === undefined);
      if (held && generation === this.generation) {
        await this.failed(held);
      }
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      await this.failed(err);
    } finally {
      this.tryBlocked = false;
    }
    if (generation !== this.generation) {
      return;
    }
    await this.publishBadges();
    await this.flush();
    if (generation === this.generation) {
      this.scheduleNext();
    }
  }

  warnOnce(key, condition, text) {
    if (condition && !this.warned.has(key)) {
      this.warned.add(key);
      this.logger.warn(text);
    }
  }

  async succeeded(count, chargesMissing) {
    this.failures = 0;
    this.offline = false;
    if (this.pauseKind === 'server') {
      this.pauseKind = undefined;
      this.pausedUntil = 0;
      this.memory.pause = null;
      await this.saveMemory();
    }
    if (this.block || this.memory.block) {
      // The test button tried the refused credentials again, and they work.
      this.block = undefined;
      this.memory.block = null;
      await this.saveMemory();
    }
    const message = count === 0 ? T.noChargePoint : T.connected(count);
    await this.setStatus(true, chargesMissing ? join(message, T.chargesMissing) : message);
  }

  blockMessage() {
    switch (this.block?.kind) {
      case 'refused':
        return T.refused;
      case 'forbidden':
        return T.forbidden;
      default:
        return T.loginRejected(this.block?.status ?? '?');
    }
  }

  async failed(err) {
    const reason = errorReason(err);
    if (FINAL.has(err.kind)) {
      // Final: never tried again automatically (refusals may lock the
      // application). Saving other credentials, or the test button, tries again.
      const salt = newSalt();
      this.block = {
        account: this.config.account,
        kind: err.kind,
        status: err.status,
        salt,
        fingerprint: fingerprint(salt, this.config.clientId, this.config.clientSecret),
      };
      this.memory.block = this.block;
      await this.saveMemory();
      this.clearTimer();
      this.logger.warn(`Monta stopped: ${reason}; no automatic try`);
      await this.setStatus(false, this.blockMessage());
      return;
    }
    if (err.kind === 'no_credentials') {
      await this.setStatus(false, T.noCredentials);
      return;
    }
    let wait;
    let message;
    if (err.kind === 'rate_limited') {
      wait = Math.min(
        TIMINGS.rateLimitMax,
        Math.max(TIMINGS.rateLimitMin, err.retryAfter ?? TIMINGS.rateLimitDefault),
      );
      this.pauseKind = 'rate';
      message = T.rateLimited(age(wait));
    } else {
      // Never read again sooner than the interval.
      wait = Math.max(
        this.config.interval,
        TIMINGS.backoff[Math.min(this.failures, TIMINGS.backoff.length - 1)],
      );
      this.pauseKind = 'server';
      this.offline = OFFLINE.has(err.kind) || this.offline;
      message =
        err.kind === 'unavailable' ? T.serverPaused(age(wait)) : T.unreachable(reason, age(wait));
    }
    this.failures += 1;
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
    this.memory.pause = { kind: this.pauseKind, until: this.pausedUntil };
    await this.saveMemory();
    await this.setStatus(err.kind === 'rate_limited' && this.readOnce, message);
    this.logger.warn(`Monta: ${reason}; next try in ${Math.round(wait / 1000)} s`);
  }

  /** A read: the charge points and (when read) their charges. */
  async apply(points, charges) {
    const next = new Map();
    for (const [id, point] of points) {
      const previous = this.points.get(id);
      // Charges not read: the charge features keep their last value.
      const charge = charges ? (charges.get(id) ?? null) : undefined;
      next.set(id, { point, charge, shown: charge === undefined ? previous?.shown : charge });
    }
    this.points = next;
    this.readOnce = true;
    const known = new Map();
    for (const [id, { charge }] of next) {
      known.set(id, charges ? (isActive(charge) ? charge.id : null) : (this.known.get(id) ?? null));
    }
    this.known = known;
    await this.rememberPoints();
    if (charges) {
      for (const id of next.keys()) {
        this.checkWatch(id, charges.get(id));
      }
    }
    await this.publishDevices();
    this.queueStates();
  }

  /** The charge points and their charge in progress, in /data (only when they change). */
  async rememberPoints() {
    const list = [...this.known].map(([id, charge]) => ({ id, charge }));
    const points = { account: this.config.account, list };
    if (JSON.stringify(points) !== JSON.stringify(this.memory.points)) {
      this.memory.points = points;
      await this.saveMemory();
    }
  }

  // --- Gladys ----------------------------------------------------------------

  async publishDevices() {
    if (!this.readOnce) {
      return;
    }
    const devices = [...this.points.values()].map(({ point }) =>
      buildDevice(this.gladys, point, this.config),
    );
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  queueStates(created = this.createdFeatures()) {
    for (const { point, shown } of this.points.values()) {
      const ids = pointIds(this.gladys, point.id);
      for (const { device_feature_external_id: id, ...value } of deviceStates(
        ids,
        point,
        shown,
        this.config,
      )) {
        if (created.has(id)) {
          this.publisher.push(id, value);
        }
      }
    }
  }

  async publishBadges() {
    const created = new Set((this.gladys.devices ?? []).map((d) => d.external_id));
    const entries = [];
    for (const { point } of this.points.values()) {
      const externalId = pointIds(this.gladys, point.id).device;
      if (created.has(externalId)) {
        const unreachable = this.offline || this.block || point.state === POINT_STATE.DISCONNECTED;
        entries.push({
          external_id: externalId,
          transport: unreachable ? DEVICE_TRANSPORTS.UNREACHABLE : DEVICE_TRANSPORTS.CLOUD,
        });
      }
    }
    const json = JSON.stringify(entries);
    if (entries.length === 0 || json === this.badges) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badges = json;
    } catch (err) {
      this.logger.warn(`Transport badges failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): send its last values at once. */
  async deviceCreated(device) {
    this.badges = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadges();
  }

  async deviceDeleted(device) {
    this.badges = undefined;
    if (device?.external_id) {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the devices of the last read (no request). */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration button ------------------------------------------------------

  pauseMessage() {
    const left = this.pausedUntil - this.now();
    if (left <= 0) {
      return undefined;
    }
    return this.pauseKind === 'rate' ? T.rateLimited(age(left)) : T.serverPaused(age(left));
  }

  /**
   * One read now, if the interval since the last attempt has passed (never
   * sooner, whatever happened before). Refused credentials are tried once:
   * only a success lifts their stop.
   */
  async testConnection() {
    if (!this.client.hasCredentials) {
      return T.noCredentials;
    }
    if (this.running) {
      return T.busy;
    }
    const paused = this.pauseMessage();
    if (paused) {
      return paused;
    }
    const wait = this.nextReadIn();
    if (wait > 0) {
      const last = this.lastMessage;
      return last ? join(T.test.cooldown(age(wait)), last) : T.test.cooldown(age(wait));
    }
    this.tryBlocked = Boolean(this.block);
    await this.tick();
    return this.lastMessage ?? T.connecting;
  }

  // --- Commands --------------------------------------------------------------------

  refusal(text) {
    return new Refusal(word(text, this.config.language));
  }

  /** The command addressed by a feature, strictly checked. */
  target(feature, value) {
    const target = parseFeatureId(feature?.external_id);
    if (
      !target ||
      !COMMAND_ROLES.includes(target.role) ||
      feature.external_id !== pointIds(this.gladys, target.id).feature(target.role)
    ) {
      throw this.refusal(ERRORS.readOnly);
    }
    if (value !== PRESSED && value !== String(PRESSED)) {
      throw this.refusal(ERRORS.badButton);
    }
    return target;
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.now();
    const { id, role } = this.target(feature, value);
    if (role === FEATURES.STOP) {
      return this.stopCommand(id, received);
    }
    return this.startCommand(id, received);
  }

  /** The checks of a start, on the latest configuration (also right before sending). */
  checkStart(generation, id) {
    if (!this.config.allowStart) {
      throw this.refusal(ERRORS.disabled);
    }
    if (generation !== this.generation || !this.client.hasCredentials || this.block) {
      throw this.refusal(this.block ? this.blockMessage() : ERRORS.notConnected);
    }
    if (this.paused) {
      throw this.refusal(this.pauseMessage());
    }
    if (!this.points.has(id)) {
      throw this.refusal(this.known.has(id) ? ERRORS.notReadYet : ERRORS.unknownChargePoint);
    }
  }

  /**
   * Waits for a command until Gladys must be answered: the outcome, or
   * `{ pending }` when Monta still works (the request goes on).
   */
  async race(request, received) {
    let handle;
    const ack = new Promise((resolve) => {
      handle = this.timers.setTimeout(
        () => resolve({ pending: true }),
        Math.max(0, received + TIMINGS.commandAck - this.now()),
      );
    });
    const outcome = await Promise.race([
      request.then(
        (json) => ({ json }),
        (err) => ({ err }),
      ),
      ack,
    ]);
    this.timers.clearTimeout(handle);
    return outcome;
  }

  /** A command error -> the refusal shown, after its effects (pause, follow-up). */
  async commandError(err, { id, isStop }) {
    if (err instanceof Refusal) {
      return err;
    }
    const reason = errorReason(err);
    this.logger.warn(`Monta: ${isStop ? 'stop' : 'start'} failed (${reason})`);
    if (err.notSent) {
      return this.refusal(err.kind === 'timeout' ? ERRORS.tooSlow : ERRORS.notSent(reason));
    }
    if (err.kind === 'rate_limited') {
      await this.failed(err);
      this.scheduleNext();
      return this.refusal(ERRORS.refused(reason));
    }
    if (err.kind === 'forbidden') {
      // A 403 on a command refuses that command only: the reads go on.
      return this.refusal(ERRORS.scope);
    }
    if (
      [
        'http',
        'unauthorized',
        'refused',
        'login_rejected',
        'refresh_refused',
        'no_credentials',
      ].includes(err.kind)
    ) {
      this.followUp();
      return this.refusal(ERRORS.refused(reason));
    }
    // A 5xx, a silence or a broken answer after the request left: it may
    // have reached Monta.
    if (!isStop) {
      this.unconfirmedUntil.set(id, this.now() + TIMINGS.guard);
    }
    this.followUp();
    return this.refusal(ERRORS.sentUnconfirmed(reason));
  }

  async startCommand(id, received) {
    const generation = this.generation;
    this.checkStart(generation, id);
    if (this.starts.has(id) || this.stops.has(id)) {
      throw this.refusal(ERRORS.stillRunning);
    }
    // The fresh read (two requests) and the start itself.
    if (this.limiter.room() < 3) {
      throw this.refusal(ERRORS.noRoom);
    }
    const entry = { stopSeq: this.stopSeq.get(id) ?? 0, sent: false };
    this.starts.set(id, entry);
    let background;
    try {
      await this.start_(id, received, generation, entry);
    } catch (err) {
      // Answered before Monta: the start stays in flight until it settles.
      background = err.background;
      throw err;
    } finally {
      if (background) {
        background.finally(() => this.starts.delete(id));
      } else {
        this.starts.delete(id);
      }
    }
  }

  /** The start itself: a fresh read, the decision, the checks again, one request. */
  async start_(id, received, generation, entry) {
    const sendBy = received + TIMINGS.commandSendBy;
    const readBy = sendBy - TIMINGS.commandMinSend;
    if (readBy - this.now() < TIMINGS.commandMinRead) {
      throw this.refusal(ERRORS.tooSlow);
    }
    const client = this.client;
    let point;
    let active;
    try {
      const [pointJson, charges] = await Promise.all([
        client.chargePoint(id, { deadline: readBy }),
        client.charges(
          {
            chargePointId: id,
            from: this.now() - TIMINGS.chargesWindow,
            perPage: LIMITS.commandCharges,
          },
          { deadline: readBy },
        ),
      ]);
      point = readChargePoint(pointJson);
      active = activeCharge(charges, id);
    } catch (err) {
      if (err.kind === 'rate_limited') {
        await this.failed(err);
        this.scheduleNext();
      }
      throw this.refusal(ERRORS.unknownState(errorReason(err)));
    }
    if (generation !== this.generation) {
      throw this.refusal(ERRORS.notConnected);
    }
    if (!point || point.id !== id) {
      throw this.refusal(ERRORS.unknownChargePoint);
    }
    // The decision, on the state just read only.
    if (active) {
      if (DRAWING_CHARGE_STATES.has(active.state)) {
        return undefined;
      }
      throw this.refusal(ERRORS.chargeInProgress(CHARGE_STATE_NAMES[active.state]));
    }
    if (NOT_READY.has(point.state)) {
      throw this.refusal(ERRORS.notReady(POINT_STATE_NAMES[point.state]));
    }
    if (point.plugged !== true) {
      throw this.refusal(ERRORS.noVehicle);
    }
    // Right before each sending: the option, the account, a stop meanwhile, the deadline.
    const beforeSend = () => {
      this.checkStart(generation, id);
      if ((this.stopSeq.get(id) ?? 0) !== entry.stopSeq) {
        throw this.refusal(ERRORS.stopMeanwhile);
      }
      if (sendBy - this.now() < TIMINGS.commandMinSend) {
        throw this.refusal(ERRORS.tooSlow);
      }
      entry.sent = true;
      this.startSentAt.set(id, this.now());
    };
    this.logger.info(`Monta: start on charge point ${id}`);
    const request = client.start(id, { sendBy, beforeSend });
    const settle = (json) => this.started_(id, json, entry, generation);
    const outcome = await this.race(request, received);
    if (outcome.pending) {
      // Sent, Monta still at work: Gladys is answered now, the state follows.
      this.unconfirmedUntil.set(id, this.now() + TIMINGS.guard);
      const background = request
        .then(settle, async (err) => {
          if (generation === this.generation) {
            await this.commandError(err, { id, isStop: false });
          }
        })
        .catch(() => {});
      throw Object.assign(this.refusal(ERRORS.pending), { background });
    }
    if (outcome.err) {
      throw await this.commandError(outcome.err, { id, isStop: false });
    }
    settle(outcome.json);
    return undefined;
  }

  /** A start answered: its charge is known; a stop clicked meanwhile stops it. */
  started_(id, json, entry, generation) {
    this.unconfirmedUntil.delete(id);
    const charge = readCharge(json);
    if (generation !== this.generation) {
      return;
    }
    if (charge && charge.chargePointId === id) {
      this.known.set(id, charge.id);
      this.rememberPoints().catch(() => {});
      if ((this.stopSeq.get(id) ?? 0) !== entry.stopSeq) {
        // A stop arrived while the start was on its way: it wins.
        this.logger.warn('Monta: a stop arrived during the start, the new charge is stopped');
        this.reassertStop(id, charge.id);
      }
    } else {
      this.unconfirmedUntil.set(id, this.now() + TIMINGS.guard);
    }
    this.followUp();
  }

  /**
   * Stopping: always possible (no option), never held back by a pause, a
   * block or the limit of requests (one request then). A stop under way for
   * the same charge point is shared.
   */
  async stopCommand(id, received) {
    if (!this.points.has(id) && !this.known.has(id)) {
      throw this.refusal(ERRORS.unknownChargePoint);
    }
    if (!this.client.hasCredentials) {
      throw this.refusal(ERRORS.notConnected);
    }
    // Any start of this charge point not sent yet gives way.
    this.stopSeq.set(id, (this.stopSeq.get(id) ?? 0) + 1);
    const running = this.stops.get(id);
    if (running) {
      return running;
    }
    const promise = this.stop_(id, received).finally(() => {
      if (this.stops.get(id) === promise) {
        this.stops.delete(id);
      }
    });
    this.stops.set(id, promise);
    return promise;
  }

  async stop_(id, received) {
    const generation = this.generation;
    const sendBy = received + TIMINGS.commandSendBy;
    const readBy = sendBy - TIMINGS.commandMinSend;
    const client = this.client;
    // A start of ours that may still land (in flight or unconfirmed).
    const mayLand = () =>
      Boolean(this.starts.get(id)?.sent) || this.now() < (this.unconfirmedUntil.get(id) ?? 0);
    // A fresh read when it costs nothing to the stop: else one request.
    const oneRequest = this.paused || this.block || !this.readOnce || this.limiter.room() < 2;
    let fresh = false;
    let chargeId;
    let readError;
    if (!oneRequest && readBy - this.now() >= TIMINGS.commandMinRead) {
      try {
        const charges = await client.charges(
          {
            chargePointId: id,
            from: this.now() - TIMINGS.chargesWindow,
            perPage: LIMITS.commandCharges,
          },
          { deadline: readBy },
        );
        fresh = true;
        chargeId = activeCharge(charges, id)?.id;
      } catch (err) {
        readError = err;
        if (err.kind === 'rate_limited') {
          await this.failed(err);
          this.scheduleNext();
        }
        this.logger.warn(`Monta: stop without a fresh read (${errorReason(err)})`);
      }
    }
    if (!fresh) {
      chargeId = this.known.get(id) ?? undefined;
    }
    if (!chargeId) {
      if (fresh) {
        // Nothing in progress now. A start of ours may still land: watched.
        if (mayLand()) {
          this.watch(id, { mayLand: true });
          this.followUp();
        }
        return;
      }
      throw this.refusal(ERRORS.noChargeKnown(readError ? errorReason(readError) : 'pause'));
    }
    const landing = mayLand();
    this.logger.info(`Monta: stop on charge point ${id}`);
    const request = client.stop(chargeId, {
      sendBy: Math.max(sendBy, this.now() + TIMINGS.commandMinSend),
    });
    // The watch begins when the stop leaves: a late start is stopped again.
    this.watch(id, { chargeId, mayLand: landing });
    const outcome = await this.race(request, received);
    const settle = (json) => {
      const charge = readCharge(json);
      if (generation === this.generation && charge && STOPPED.has(charge.state)) {
        this.known.set(id, null);
        this.rememberPoints().catch(() => {});
      }
      this.followUp();
    };
    if (outcome.pending) {
      request
        .then(settle, async (err) => {
          if (generation === this.generation) {
            await this.commandError(err, { id, isStop: true });
          }
        })
        .catch(() => {});
      throw this.refusal(ERRORS.pending);
    }
    if (outcome.err) {
      throw await this.commandError(outcome.err, { id, isStop: true });
    }
    settle(outcome.json);
  }

  // --- Watch after a stop ------------------------------------------------------------

  /**
   * After a stop left: for 90 s, a read showing that charge (or, when a start
   * of ours could still land, any charge) drawing again sends the stop again,
   * twice at most. A charge started by someone else afterwards (another id,
   * no start of ours pending) is never stopped.
   */
  watch(id, { chargeId, mayLand = false }) {
    const held = this.watches.get(id);
    const now = this.now();
    const active = held && now < held.until;
    this.watches.set(id, {
      sentAt: now,
      until: now + TIMINGS.guard,
      chargeId: chargeId ?? (active ? held.chargeId : undefined),
      mayLand: mayLand || Boolean(active && held.mayLand),
      // A renewed watch keeps what its reaffirmations already spent.
      reasserts: active ? held.reasserts : 0,
    });
  }

  checkWatch(id, charge) {
    const watch = this.watches.get(id);
    if (!watch) {
      return;
    }
    const now = this.now();
    if (now >= watch.until) {
      this.watches.delete(id);
      return;
    }
    if (
      !charge ||
      !DRAWING_CHARGE_STATES.has(charge.state) ||
      now - watch.sentAt < TIMINGS.stopSettle ||
      watch.reasserts >= TIMINGS.stopReasserts ||
      (this.startSentAt.get(id) ?? -Infinity) > watch.sentAt
    ) {
      return;
    }
    if (charge.id === watch.chargeId || watch.mayLand) {
      watch.reasserts += 1;
      this.logger.warn('Monta: a charge is drawing again after a stop, stop sent again');
      this.reassertStop(id, charge.id);
    }
  }

  /** Sends a stop again (no read, no option): one request, its failure only logged. */
  reassertStop(id, chargeId) {
    const generation = this.generation;
    this.client
      .stop(chargeId, {})
      .then(() => this.followUp())
      .catch(async (err) => {
        this.logger.warn(`Monta: stop sent again failed (${errorReason(err)})`);
        const watch = this.watches.get(id);
        if (watch) {
          // A failed resend never spends a reaffirmation.
          watch.reasserts = Math.max(0, watch.reasserts - 1);
          watch.until = Math.min(watch.sentAt + 10 * MINUTE, watch.until + TIMINGS.guard);
        }
        if (err.kind === 'rate_limited' && generation === this.generation) {
          await this.failed(err);
          this.scheduleNext();
        } else {
          this.followUp();
        }
      })
      .catch(() => {});
  }

  /**
   * A read after a command (its effect), whatever the interval: one pending
   * at a time, it still waits for a pause and for the limit of requests.
   */
  followUp() {
    if (this.followTimer) {
      this.timers.clearTimeout(this.followTimer);
    }
    const generation = this.generation;
    this.followTimer = this.timers.setTimeout(() => {
      this.followTimer = undefined;
      if (generation === this.generation) {
        Promise.resolve(this.running)
          .catch(() => {})
          .then(() => this.tick({ followUp: true }))
          .catch(() => this.logger.error('Monta refresh failed'));
      }
    }, TIMINGS.followUp);
  }
}

export { MontaError };
