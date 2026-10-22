import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeCharge,
  currentCharges,
  readCharge,
  readChargePoint,
  readChargePoints,
} from '../src/model.js';
import { LIMITS } from '../src/constants.js';
import { charge, chargePoint } from './helpers/fakeMonta.js';

test('a charge point keeps only the fields used, never its location', () => {
  const point = readChargePoint(chargePoint());
  assert.deepEqual(point, {
    id: 4711,
    name: 'Garage',
    state: 'busy-non-charging',
    plugged: true,
    maxKw: 11,
    meterKwh: 1234.5,
    brand: 'Easee',
    model: 'Home',
    firmware: '1.2.3',
    type: 'ac',
  });
  assert.ok(!JSON.stringify(point).includes('Private Street'));
});

test('identity rule: a positive integer id and a serial number; a readable fallback name', () => {
  assert.equal(readChargePoint(chargePoint({ id: '4711' })), undefined);
  assert.equal(readChargePoint(chargePoint({ id: 0 })), undefined);
  assert.equal(readChargePoint(chargePoint({ id: 1.5 })), undefined);
  assert.equal(readChargePoint(chargePoint({ serialNumber: null })), undefined);
  assert.equal(readChargePoint(chargePoint({ name: null })).name, 'Monta 4711');
  assert.equal(readChargePoint(chargePoint({ name: 'a\u0000b\nc' })).name, 'a b c');
});

test('odd values are undefined, never 0 nor a guess', () => {
  const point = readChargePoint(
    chargePoint({
      state: 'exploded',
      cablePluggedIn: 'yes',
      lastMeterReadingKwh: '12',
      maxKw: -1,
      type: 'xx',
    }),
  );
  assert.equal(point.state, 'unknown');
  assert.equal(point.plugged, undefined);
  assert.equal(point.meterKwh, undefined);
  assert.equal(point.maxKw, undefined);
  assert.equal(point.type, undefined);
  assert.equal(readCharge(charge({ state: 'weird' })), undefined);
  assert.equal(readCharge(charge({ consumedKwh: null })).consumedKwh, undefined);
  assert.equal(readCharge(charge({ soc: { percentage: 120 } })).soc, undefined);
});

test('no prototype pollution from hostile JSON', () => {
  const hostile = JSON.parse(
    '{"id":5,"serialNumber":"x","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}',
  );
  const { points } = readChargePoints([hostile, hostile]);
  assert.equal(points.size, 1);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

test('the list is bounded and deduplicated', () => {
  const items = Array.from({ length: LIMITS.chargePoints + 10 }, (_, i) =>
    chargePoint({ id: i + 1 }),
  );
  items.push(chargePoint({ id: 1 }), { nope: true }, null, 'x');
  const { points, dropped } = readChargePoints(items);
  assert.equal(points.size, LIMITS.chargePoints);
  assert.equal(dropped, 3);
});

test('the charge shown: the latest in progress, else the latest; a stop finds the active one', () => {
  const list = [
    charge({ id: 10, state: 'charging' }),
    charge({ id: 12, state: 'completed' }),
    charge({ id: 11, state: 'paused' }),
    charge({ id: 20, chargePointId: 99, state: 'completed' }),
  ];
  assert.equal(currentCharges(list).get(4711).id, 11);
  assert.equal(currentCharges(list).get(99).id, 20);
  assert.equal(activeCharge(list, 4711).id, 11);
  assert.equal(activeCharge(list, 99), undefined);
});
