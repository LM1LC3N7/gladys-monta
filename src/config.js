// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { POLL_INTERVAL, SECOND } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). Secrets aside. */
export const DEFAULT_CONFIG = {
  client_id: '',
  allow_start: false,
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

export const LANGUAGES = ['fr', 'en'];

/** A short hash of the client id: the account the state in /data belongs to. */
export const accountKey = (clientId) =>
  createHash('sha256').update(`monta-account:${clientId}`).digest('hex').slice(0, 16);

/** A boolean field: only `true` (or the strings Gladys may send) turns it on. */
const flag = (value) => value === true || value === 'true' || value === 1 || value === '1';

/** A text field, trimmed and bounded (an absurd value is ignored). */
const field = (value, max = 256) => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length <= max ? text : '';
};

export function normalizeConfig(raw = {}) {
  const clientId = field(raw?.client_id);
  // The secret is sent as typed, only trimmed of the blanks a paste adds.
  const clientSecret = field(raw?.client_secret, 1024);
  const seconds = Number(raw?.poll_interval);
  const interval = Number.isFinite(seconds)
    ? Math.min(POLL_INTERVAL.max, Math.max(POLL_INTERVAL.min, Math.round(seconds)))
    : POLL_INTERVAL.default;
  const language = String(raw?.language ?? DEFAULT_CONFIG.language)
    .trim()
    .toLowerCase();
  return {
    clientId,
    clientSecret,
    /** The hash of the client id: the stops and the charges in /data belong to it. */
    account: clientId === '' ? '' : accountKey(clientId),
    allowStart: flag(raw?.allow_start),
    interval: interval * SECOND,
    language: LANGUAGES.includes(language) ? language : DEFAULT_CONFIG.language,
  };
}
