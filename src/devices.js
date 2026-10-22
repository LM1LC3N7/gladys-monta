// -----------------------------------------------------------------------------
// A charge point -> one Gladys device and its states (pure).
//
// `ext:<selector>:monta:<id>`: one device per charge point, keyed by its Monta
// `id` (src/model.js), never by its name. The feature roles (the last part of
// their external ids) are published forever: never rename them. Every role
// is always built, so a republished device never loses a feature.
//
// No switch, no writable binary: a "turn everything off" (Google Home, Alexa,
// HomeKit, MCP, `switch.*` scenes) must never reach a charge command.
// Starting and stopping are two `button/push` features; starting refuses
// unless the configuration allows it, stopping is always possible.
//
// Categories and units are those the core lists
// (DEVICE_FEATURE_UNITS_BY_CATEGORY): kWh on `electrical-vehicle-charge`, % on
// `electrical-vehicle-battery`. No power: the public API of Monta gives none.
// The meter reading is a plain sensor (`charge-energy-consumption-total`),
// never an `energy-sensor` index: the energy tab never counts it (the charge
// point is behind the main meter), and it is never published as 0.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { CHARGE_STATE, FEATURES, POINT_STATE } from './constants.js';
import { CHARGE_STATE_NAMES, FEATURE_NAMES, NONE, POINT_STATE_NAMES, word } from './i18n.js';

/** CHARGING_STATION_CONNECTOR_STATUS of the core (server/utils/constants.js). */
export const CONNECTOR_STATUS = {
  AVAILABLE: 0,
  OCCUPIED: 1,
  RESERVED: 2,
  UNAVAILABLE: 3,
  FAULTED: 4,
};

/** CHARGING_STATION_CHARGING_STATE of the core (OCPP 2.0.1 chargingState). */
export const CHARGING_STATE = {
  CHARGING: 0,
  EV_CONNECTED: 1,
  PAUSED_BY_VEHICLE: 2,
  PAUSED_BY_CHARGER: 3,
  IDLE: 4,
  DISCHARGING: 5,
};

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const text = sensor({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, keep_history: false });
const button = {
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
};

/** The features, by role, in display order. */
export const DEFINITIONS = {
  [FEATURES.STATUS]: text,
  [FEATURES.CONNECTOR]: sensor({
    category: C.CHARGING_STATION,
    type: T.CHARGING_STATION.CONNECTOR_STATUS,
    min: 0,
    max: 4,
  }),
  [FEATURES.CHARGING_STATE]: sensor({
    category: C.CHARGING_STATION,
    type: T.CHARGING_STATION.CHARGING_STATE,
    min: 0,
    max: 5,
  }),
  [FEATURES.PLUGGED]: sensor({
    category: C.ELECTRICAL_VEHICLE_CHARGE,
    type: T.ELECTRICAL_VEHICLE_CHARGE.PLUGGED,
    min: 0,
    max: 1,
  }),
  [FEATURES.CHARGE_STATUS]: text,
  [FEATURES.SESSION_ENERGY]: sensor({
    category: C.ELECTRICAL_VEHICLE_CHARGE,
    type: T.ELECTRICAL_VEHICLE_CHARGE.LAST_CHARGE_ENERGY_ADDED,
    unit: U.KILOWATT_HOUR,
    min: 0,
    max: 10_000,
  }),
  [FEATURES.VEHICLE_BATTERY]: sensor({
    category: C.ELECTRICAL_VEHICLE_BATTERY,
    type: T.ELECTRICAL_VEHICLE_BATTERY.BATTERY_LEVEL,
    unit: U.PERCENT,
    min: 0,
    max: 100,
  }),
  [FEATURES.METER]: sensor({
    category: C.ELECTRICAL_VEHICLE_CHARGE,
    type: T.ELECTRICAL_VEHICLE_CHARGE.CHARGE_ENERGY_CONSUMPTION_TOTAL,
    unit: U.KILOWATT_HOUR,
    min: 0,
    max: 100_000_000,
  }),
  [FEATURES.START]: button,
  [FEATURES.STOP]: button,
};

export const ROLES = Object.keys(DEFINITIONS);
export const COMMAND_ROLES = [FEATURES.START, FEATURES.STOP];

export const pointIds = (gladys, id) => gladys.externalIds('monta', String(id));

/** The id and the role of one of our feature external ids, else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string' || externalId.length > 512) {
    return undefined;
  }
  const match = /:monta:([1-9][0-9]{0,15}):([a-z0-9-]{1,40})$/.exec(externalId);
  if (!match || !ROLES.includes(match[2])) {
    return undefined;
  }
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? { id, role: match[2] } : undefined;
}

export function buildDevice(gladys, point, { language }) {
  const ids = pointIds(gladys, point.id);
  const params = [{ name: 'monta_id', value: String(point.id) }];
  if (point.firmware) params.push({ name: 'firmware', value: point.firmware });
  if (point.maxKw !== undefined) params.push({ name: 'max_kw', value: String(point.maxKw) });
  if (point.type) params.push({ name: 'current_type', value: point.type.toUpperCase() });
  const model = [point.brand, point.model].filter(Boolean).join(' ');
  return {
    name: point.name,
    external_id: ids.device,
    model: model || 'Monta',
    should_poll: false,
    features: ROLES.map((role) => ({
      name: word(FEATURE_NAMES[role], language),
      external_id: ids.feature(role),
      ...DEFINITIONS[role],
    })),
    params,
  };
}

/** The connector, as the core's charging-station category reads it (undefined: unknown). */
export function connectorOf(state) {
  switch (state) {
    case POINT_STATE.AVAILABLE:
      return CONNECTOR_STATUS.AVAILABLE;
    case POINT_STATE.BUSY:
    case POINT_STATE.BUSY_BLOCKED:
    case POINT_STATE.BUSY_CHARGING:
    case POINT_STATE.BUSY_NON_CHARGING:
    case POINT_STATE.BUSY_NON_RELEASED:
    case POINT_STATE.BUSY_SCHEDULED:
      return CONNECTOR_STATUS.OCCUPIED;
    case POINT_STATE.BUSY_RESERVED:
      return CONNECTOR_STATUS.RESERVED;
    case POINT_STATE.DISCONNECTED:
      return CONNECTOR_STATUS.UNAVAILABLE;
    case POINT_STATE.ERROR:
      return CONNECTOR_STATUS.FAULTED;
    default:
      return undefined;
  }
}

/**
 * The charging state (OCPP's chargingState), from the charge point and its
 * charge. Free or in error: IDLE, so a scene never keeps reading "charging"
 * after the car left. Unknown (disconnected, passive): undefined.
 */
export function chargingStateOf(state, charge) {
  switch (state) {
    case POINT_STATE.BUSY_CHARGING:
      return CHARGING_STATE.CHARGING;
    case POINT_STATE.BUSY_NON_CHARGING:
    case POINT_STATE.BUSY_NON_RELEASED:
    case POINT_STATE.BUSY_SCHEDULED:
      return CHARGING_STATE.EV_CONNECTED;
    case POINT_STATE.BUSY_BLOCKED:
      return CHARGING_STATE.PAUSED_BY_CHARGER;
    case POINT_STATE.AVAILABLE:
    case POINT_STATE.BUSY_RESERVED:
    case POINT_STATE.ERROR:
      return CHARGING_STATE.IDLE;
    case POINT_STATE.BUSY:
      if (charge?.state === CHARGE_STATE.CHARGING) return CHARGING_STATE.CHARGING;
      if (charge?.state === CHARGE_STATE.PAUSED) return CHARGING_STATE.PAUSED_BY_CHARGER;
      return CHARGING_STATE.EV_CONNECTED;
    default:
      return undefined;
  }
}

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

/**
 * The current values of a charge point's device. `charge`: the charge to
 * show (src/model.js currentCharges), `null` when the charges were read and
 * there is none, `undefined` when they could not be read (its features then
 * keep their last value). Disconnected from Monta: only the status and the
 * connector (Gladys keeps the last value of the others).
 */
export function deviceStates(ids, point, charge, { language }) {
  const states = [];
  // A value outside the bounds of its feature is dropped (Gladys keeps the last one).
  const add = (role, value) => {
    const { min, max } = DEFINITIONS[role];
    if (value !== undefined && Number.isFinite(value) && value >= min && value <= max) {
      states.push({ role, state: value });
    }
  };
  states.push({
    role: FEATURES.STATUS,
    text: word(POINT_STATE_NAMES[point.state] ?? POINT_STATE_NAMES.unknown, language),
  });
  add(FEATURES.CONNECTOR, connectorOf(point.state));
  if (point.state !== POINT_STATE.DISCONNECTED) {
    add(FEATURES.CHARGING_STATE, chargingStateOf(point.state, charge));
    if (point.plugged !== undefined) add(FEATURES.PLUGGED, point.plugged ? 1 : 0);
    // Never 0 (a reset glitch): a plain sensor, yet a chart would show a drop.
    if (point.meterKwh !== undefined && point.meterKwh > 0) {
      add(FEATURES.METER, round(point.meterKwh, 3));
    }
    if (charge === null) {
      states.push({ role: FEATURES.CHARGE_STATUS, text: word(NONE, language) });
    } else if (charge) {
      states.push({
        role: FEATURES.CHARGE_STATUS,
        text: word(CHARGE_STATE_NAMES[charge.state], language),
      });
      if (charge.consumedKwh !== undefined) {
        add(FEATURES.SESSION_ENERGY, round(charge.consumedKwh, 3));
      }
      if (charge.soc !== undefined) add(FEATURES.VEHICLE_BATTERY, Math.round(charge.soc));
    }
  }
  return states.map(({ role, ...value }) => ({
    device_feature_external_id: ids.feature(role),
    ...value,
  }));
}
