// The part of DEVICE_FEATURE_UNITS_BY_CATEGORY (server/utils/constants.js of
// the Gladys core) this integration uses, copied from the core.
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';

export const DEVICE_FEATURE_UNITS_BY_CATEGORY = {
  [C.ELECTRICAL_VEHICLE_BATTERY]: [
    U.CELSIUS,
    U.FAHRENHEIT,
    U.KILOWATT,
    U.KILOWATT_HOUR,
    U.KM,
    U.MILE,
    U.PERCENT,
    U.VOLT,
  ],
  [C.ELECTRICAL_VEHICLE_CHARGE]: [
    U.AMPERE,
    U.KILOWATT,
    U.KILOWATT_HOUR,
    U.MEGAWATT_HOUR,
    U.PERCENT,
    U.VOLT,
  ],
};
