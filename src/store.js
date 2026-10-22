// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container). Never a token, never the client secret, never the client id
// itself, never the location of a charge point:
//   - the time of the last read attempt (written before each read, at most
//     once a minute): a restart never reads sooner than the interval;
//   - the end of a 429 or 5xx pause (bounded);
//   - a stop after refused credentials (or a 403 on the charge points): final,
//     no automatic try. It holds a salted fingerprint of the REFUSED
//     credentials only (never of working ones), so saving other credentials
//     lifts it; it is erased at the first success;
//   - per account (a hash of the client id), the ids of the charge points and
//     of their charge in progress, so a stop stays possible after a restart,
//     before the first read.
// Every time read back is bounded. The file is readable by the container
// user only (0600).
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { LIMITS, TIMINGS } from './constants.js';
import { validId } from './model.js';

export const STATE_FILE = '/data/monta-state.json';

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        const text = await readFile(path, 'utf8');
        return text.length <= 256 * 1024 ? JSON.parse(text) : null;
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

const HEX = /^[0-9a-f]{16,64}$/;
const time = (value) => (Number.isFinite(value) ? value : undefined);

/** A time read back from /data: in the future, at most 24 h away, else undefined. */
export const bounded = (value, now) => {
  const t = time(value);
  return t !== undefined && t > now ? Math.min(t, now + TIMINGS.persistedMax) : undefined;
};

/** A new salt for a fingerprint. */
export const newSalt = () => randomBytes(16).toString('hex');

/** The salted fingerprint of refused credentials (only ever of refused ones). */
export const fingerprint = (salt, clientId, clientSecret) =>
  createHash('sha256').update(`${salt}\n${clientId}\n${clientSecret}`).digest('hex');

export const BLOCKS = new Set(['refused', 'login_rejected', 'forbidden']);
const PAUSES = new Set(['rate', 'server']);

/** The persisted state, repaired and bounded. */
export function normalizeMemory(raw, now) {
  const last = time(raw?.lastAttemptAt);
  // A time in the future (clock moved back) counts as now: never a longer wait.
  const lastAttemptAt = last === undefined ? undefined : Math.min(last, now);

  const p = raw?.pause;
  const until = bounded(p?.until, now);
  const pause = until !== undefined && PAUSES.has(p?.kind) ? { kind: p.kind, until } : null;

  const b = raw?.block;
  const block =
    typeof b?.account === 'string' &&
    HEX.test(b.account) &&
    BLOCKS.has(b.kind) &&
    typeof b.salt === 'string' &&
    HEX.test(b.salt) &&
    typeof b.fingerprint === 'string' &&
    HEX.test(b.fingerprint)
      ? {
          account: b.account,
          kind: b.kind,
          status: Number.isInteger(b.status) ? b.status : undefined,
          salt: b.salt,
          fingerprint: b.fingerprint,
        }
      : null;

  const s = raw?.points;
  const points =
    typeof s?.account === 'string' && HEX.test(s.account) && Array.isArray(s.list)
      ? {
          account: s.account,
          list: s.list
            .filter((entry) => validId(entry?.id))
            .slice(0, LIMITS.chargePoints)
            .map((entry) => ({
              id: entry.id,
              charge: validId(entry.charge) ? entry.charge : null,
            })),
        }
      : null;

  return { lastAttemptAt, pause, block, points };
}
