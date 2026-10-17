// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), never the e-mail nor the password:
//   - the `x-picnic-did` device id (one per installation);
//   - the session token, with the account it belongs to (country and a hash
//     of the e-mail), so a restart does not sign in again;
//   - a sign-in waiting for its verification code (its token and when);
//   - the deliveries already announced by the "delivery approaching" trigger.
// The file is readable by the container user only (0600).
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { LIMITS } from './constants.js';

export const STATE_FILE = '/data/picnic-state.json';

export function fileStore(path = STATE_FILE) {
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, 'utf8'));
      } catch {
        return null;
      }
    },
    async save(data) {
      const temporary = `${path}.tmp`;
      await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
      await rename(temporary, path);
    },
  };
}

/** A device id shaped like the library's (16 upper-case hex digits). */
export const newDeviceId = () => randomBytes(8).toString('hex').toUpperCase();

const tokenEntry = (raw) =>
  raw && typeof raw.token === 'string' && raw.token !== '' && typeof raw.account === 'string'
    ? raw
    : null;

/** The persisted state, repaired. */
export function normalizeMemory(raw) {
  const did = typeof raw?.did === 'string' && /^[0-9A-F]{16}$/.test(raw.did) ? raw.did : null;
  const s = tokenEntry(raw?.session);
  const p = tokenEntry(raw?.pending);
  return {
    did,
    session: s
      ? {
          account: s.account,
          token: s.token,
          expiresAt: Number.isFinite(s.expiresAt) ? s.expiresAt : undefined,
        }
      : null,
    pending: p && Number.isFinite(p.at) ? { account: p.account, token: p.token, at: p.at } : null,
    announced: Array.isArray(raw?.announced)
      ? raw.announced.filter((id) => typeof id === 'string').slice(-LIMITS.announced)
      : [],
  };
}
