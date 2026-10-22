import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { DEVICE_FEATURE_UNITS_BY_CATEGORY } from './helpers/coreUnits.js';
import {
  CHARGING_STATE,
  CONNECTOR_STATUS,
  DEFINITIONS,
  ROLES,
  buildDevice,
  chargingStateOf,
  connectorOf,
  deviceStates,
  parseFeatureId,
  pointIds,
} from '../src/devices.js';
import { FEATURES, POINT_STATE } from '../src/constants.js';
import { readCharge, readChargePoint } from '../src/model.js';
import { charge, chargePoint } from './helpers/fakeMonta.js';

const gladys = createFakeGladys();
const ids = pointIds(gladys, 4711);
const byRole = (states) =>
  Object.fromEntries(
    states.map(({ device_feature_external_id: id, state, text }) => [
      id.slice(ids.device.length + 1),
      state ?? text,
    ]),
  );

test('units are those the core lists for the category', () => {
  for (const [role, definition] of Object.entries(DEFINITIONS)) {
    if (definition.unit !== undefined) {
      assert.ok(
        DEVICE_FEATURE_UNITS_BY_CATEGORY[definition.category]?.includes(definition.unit),
        `${role}: ${definition.unit} not allowed for ${definition.category}`,
      );
    }
  }
});

test('the roles are forever, every one always built; no switch, no writable binary', () => {
  assert.deepEqual(ROLES, [
    'status',
    'connector-status',
    'charging-state',
    'plugged',
    'charge-status',
    'session-energy',
    'vehicle-battery',
    'meter-reading',
    'start-charge',
    'stop-charge',
  ]);
  const device = buildDevice(gladys, readChargePoint(chargePoint({ brandName: null })), {
    language: 'en',
  });
  assert.equal(device.features.length, ROLES.length);
  assert.equal(device.model, 'Home');
  for (const f of device.features) {
    assert.notEqual(f.category, 'switch');
    if (!f.read_only) {
      assert.equal(f.category, 'button', f.external_id);
    }
    assert.notEqual(f.category, 'energy-sensor', 'never an index the energy tab counts');
  }
  assert.ok(!JSON.stringify(device).includes('SN-0001'), 'no serial number in the device');
});

test('feature ids are parsed strictly', () => {
  assert.deepEqual(parseFeatureId(ids.feature('stop-charge')), { id: 4711, role: 'stop-charge' });
  assert.equal(parseFeatureId(`${ids.device}:unknown`), undefined);
  assert.equal(parseFeatureId('ext:x:monta:0:stop-charge'), undefined);
  assert.equal(parseFeatureId(42), undefined);
});

test('connector and charging state from the Monta states', () => {
  assert.equal(connectorOf(POINT_STATE.AVAILABLE), CONNECTOR_STATUS.AVAILABLE);
  assert.equal(connectorOf(POINT_STATE.BUSY_CHARGING), CONNECTOR_STATUS.OCCUPIED);
  assert.equal(connectorOf(POINT_STATE.BUSY_RESERVED), CONNECTOR_STATUS.RESERVED);
  assert.equal(connectorOf(POINT_STATE.DISCONNECTED), CONNECTOR_STATUS.UNAVAILABLE);
  assert.equal(connectorOf(POINT_STATE.ERROR), CONNECTOR_STATUS.FAULTED);
  assert.equal(connectorOf(POINT_STATE.PASSIVE), undefined);
  assert.equal(chargingStateOf(POINT_STATE.BUSY_CHARGING), CHARGING_STATE.CHARGING);
  assert.equal(chargingStateOf(POINT_STATE.AVAILABLE), CHARGING_STATE.IDLE);
  assert.equal(
    chargingStateOf(POINT_STATE.BUSY, readCharge(charge({ state: 'charging' }))),
    CHARGING_STATE.CHARGING,
  );
  assert.equal(chargingStateOf('unknown'), undefined);
});

test('states: a charge, no charge, charges not read, disconnected; the meter never 0', () => {
  const point = readChargePoint(chargePoint());
  const states = byRole(deviceStates(ids, point, readCharge(charge()), { language: 'en' }));
  assert.equal(states[FEATURES.SESSION_ENERGY], 12.345);
  assert.equal(states[FEATURES.VEHICLE_BATTERY], 80);
  assert.equal(states[FEATURES.CHARGE_STATUS], 'Completed');

  const none = byRole(deviceStates(ids, point, null, { language: 'en' }));
  assert.equal(none[FEATURES.CHARGE_STATUS], 'No charge');
  assert.equal(none[FEATURES.SESSION_ENERGY], undefined);

  const unread = byRole(deviceStates(ids, point, undefined, { language: 'en' }));
  assert.equal(unread[FEATURES.CHARGE_STATUS], undefined);

  const zero = byRole(
    deviceStates(ids, readChargePoint(chargePoint({ lastMeterReadingKwh: 0 })), null, {
      language: 'en',
    }),
  );
  assert.equal(zero[FEATURES.METER], undefined);

  const off = byRole(
    deviceStates(ids, readChargePoint(chargePoint({ state: 'disconnected' })), null, {
      language: 'fr',
    }),
  );
  assert.deepEqual(Object.keys(off), ['status', 'connector-status']);
  assert.equal(off.status, 'Déconnectée de Monta');
  for (const value of Object.values(states)) {
    assert.ok(value !== undefined && !Number.isNaN(value));
  }
});
