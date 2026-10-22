// -----------------------------------------------------------------------------
// The answers of Monta -> plain values (pure). Every field is checked: a
// missing or odd value is `undefined`, never 0, never a guess. Only the
// fields used are kept: never the location (address, coordinates) of a
// charge point.
//
// Identity rule (it fixes the external ids, forever): a charge point is its
// Monta `id` (a positive integer). The list keeps only the charge points that
// have a serial number, as monta-python does (the others are not chargers of
// the account). Its name falls back to "Monta <id>" when Monta sends none.
// -----------------------------------------------------------------------------

import { ACTIVE_CHARGE_STATES, CHARGE_STATE, LIMITS, POINT_STATE } from './constants.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const POINT_STATES = new Set(Object.values(POINT_STATE));
const CHARGE_STATES = new Set(Object.values(CHARGE_STATE));

/** A Monta id: a positive safe integer. */
export const validId = (value) => Number.isSafeInteger(value) && value > 0;

/** A finite number within [min, max], else undefined (null, '', true are never numbers). */
const number = (value, min, max) =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : undefined;

/** A short text without control characters, else undefined. */
export function text(value, max = LIMITS.text) {
  if (typeof value !== 'string') {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return clean === '' ? undefined : clean.slice(0, max);
}

/** One item of `charge-points` -> a charge point, or undefined when it is not usable. */
export function readChargePoint(item) {
  if (!isObject(item) || !validId(item.id) || text(item.serialNumber, 128) === undefined) {
    return undefined;
  }
  const state =
    typeof item.state === 'string' && POINT_STATES.has(item.state) ? item.state : 'unknown';
  return {
    id: item.id,
    name: text(item.name) ?? `Monta ${item.id}`,
    state,
    plugged: typeof item.cablePluggedIn === 'boolean' ? item.cablePluggedIn : undefined,
    maxKw: number(item.maxKw, 0, 1000),
    meterKwh: number(item.lastMeterReadingKwh, 0, 100_000_000),
    brand: text(item.brandName),
    model: text(item.modelName),
    firmware: text(item.firmwareVersion),
    type: item.type === 'ac' || item.type === 'dc' ? item.type : undefined,
  };
}

/** One item of `charges` -> a charge, or undefined. */
export function readCharge(item) {
  if (!isObject(item) || !validId(item.id) || !validId(item.chargePointId)) {
    return undefined;
  }
  if (typeof item.state !== 'string' || !CHARGE_STATES.has(item.state)) {
    return undefined;
  }
  const soc = isObject(item.soc) ? number(item.soc.percentage, 0, 100) : undefined;
  return {
    id: item.id,
    chargePointId: item.chargePointId,
    state: item.state,
    consumedKwh: number(item.consumedKwh, 0, 10_000),
    soc,
  };
}

/** The charge points of a list (duplicates and unusable items dropped, bounded). */
export function readChargePoints(items) {
  const points = new Map();
  let dropped = 0;
  for (const item of Array.isArray(items) ? items : []) {
    const point = readChargePoint(item);
    if (!point) {
      dropped += 1;
    } else if (!points.has(point.id) && points.size < LIMITS.chargePoints) {
      points.set(point.id, point);
    }
  }
  return { points, dropped };
}

/**
 * The charge to show for each charge point, from a list: the most recent one
 * in progress, else the most recent one (the highest id).
 */
export function currentCharges(items) {
  const current = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const charge = readCharge(item);
    if (!charge) {
      continue;
    }
    const held = current.get(charge.chargePointId);
    const better =
      !held ||
      (isActive(charge) && !isActive(held)) ||
      (isActive(charge) === isActive(held) && charge.id > held.id);
    if (better) {
      current.set(charge.chargePointId, charge);
    }
  }
  return current;
}

/** The charge in progress of a list for one charge point (the most recent), else undefined. */
export function activeCharge(items, chargePointId) {
  let found;
  for (const item of Array.isArray(items) ? items : []) {
    const charge = readCharge(item);
    if (
      charge?.chargePointId === chargePointId &&
      ACTIVE_CHARGE_STATES.has(charge.state) &&
      (found?.id ?? 0) < charge.id
    ) {
      found = charge;
    }
  }
  return found;
}

export const isActive = (charge) => Boolean(charge) && ACTIVE_CHARGE_STATES.has(charge.state);
