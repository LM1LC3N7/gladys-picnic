// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), never the e-mail nor the password:
//   - the `x-picnic-did` device id (one per installation);
//   - the session token, with the account it belongs to (country and a hash
//     of the e-mail), so a restart does not sign in again;
//   - a sign-in waiting for its verification code (its token and when), and
//     when a code was last requested (one a minute, across restarts);
//   - the device key of the account (the Picnic user id, chosen once);
//   - the end of a 429 pause (kept across restarts and account changes);
//   - the deliveries already announced by the "delivery approaching" trigger.
// The file is readable by the container user only (0600).
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { LIMITS } from './constants.js';

export const STATE_FILE = '/data/picnic-state.json';

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, 'utf8'));
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

/** A device id shaped like the library's (16 upper-case hex digits). */
export const newDeviceId = () => randomBytes(8).toString('hex').toUpperCase();

const time = (value) => (Number.isFinite(value) ? value : undefined);
const id = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : undefined;

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
          expiresAt: time(s.expiresAt),
          userId: id(s.userId),
        }
      : null,
    pending:
      p && Number.isFinite(p.at)
        ? { account: p.account, token: p.token, at: p.at, userId: id(p.userId) }
        : null,
    codeAt: time(raw?.codeAt),
    rateLimitedUntil: time(raw?.rateLimitedUntil),
    deviceKey:
      typeof raw?.deviceKey?.account === 'string' && id(raw.deviceKey.key)
        ? { account: raw.deviceKey.account, key: raw.deviceKey.key }
        : null,
    announced: Array.isArray(raw?.announced)
      ? raw.announced.filter((id) => typeof id === 'string').slice(-LIMITS.announced)
      : [],
  };
}
