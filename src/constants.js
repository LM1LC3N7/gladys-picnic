// -----------------------------------------------------------------------------
// Manifest keys, Picnic API constants, limits and timings.
//
// The API is the one of the Picnic app, undocumented. Hosts, paths, headers
// and the sign-in are those of python-picnic-api2 (Apache-2.0,
// codesalatdev/python-picnic-api); the sensors and the polling around a
// delivery follow the Picnic integration of Home Assistant (Apache-2.0).
// -----------------------------------------------------------------------------

/** Countries Picnic serves, as python-picnic-api2 and Home Assistant list them. */
export const COUNTRIES = ['NL', 'DE', 'BE', 'FR'];

/** API version of python-picnic-api2 (DEFAULT_API_VERSION), the same in every country. */
export const API_VERSION = '15';

/** `https://storefront-prod.<cc>.picnicinternational.com/api/15` (the library's DEFAULT_URL). */
export const baseUrlOf = (country) =>
  `https://storefront-prod.${String(country).toLowerCase()}.picnicinternational.com/api/${API_VERSION}`;

/** API paths, relative to the base URL. */
export const PATHS = {
  login: '/user/login',
  generateCode: '/user/2fa/generate',
  verifyCode: '/user/2fa/verify',
  cart: '/cart',
  deliveries: '/deliveries/summary',
  position: (deliveryId) => `/deliveries/${encodeURIComponent(deliveryId)}/position`,
};

/** Headers of python-picnic-api2: the session token travels in `x-picnic-auth`. */
export const HEADERS = {
  auth: 'x-picnic-auth',
  userAgent: 'okhttp/4.9.0',
  /** `_HEADERS` of the library, sent on the sign-in, the 2FA calls, the cart and the position. */
  agent: '30100;1.206.1-#15408',
  clientId: 30100,
};

/** Delivery statuses of /deliveries/summary. */
export const DELIVERY_STATUS = {
  CURRENT: 'CURRENT',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
};

/** Channels of POST /user/2fa/generate (python-picnic-api2: "SMS" or "EMAIL"). */
export const CODE_CHANNELS = { sms: 'SMS', email: 'EMAIL' };

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
  REQUEST_CODE: 'request_code',
  VERIFY_CODE: 'verify_code',
};

export const SCENE_TRIGGERS = {
  DELIVERY_APPROACHING: 'delivery_approaching',
};

/** Refresh interval, in minutes. */
export const POLL_INTERVAL = { min: 5, max: 60, default: 15 };

/** "Delivery approaching" lead, in minutes before the estimated arrival. */
export const APPROACH = { min: 5, max: 60, default: 15 };

export const LIMITS = {
  /** Gladys: 300 states per minute, 300 scene events per minute. */
  statesPerMinute: 300,
  sceneEventsPerMinute: 300,
  statesPerRequest: 100,
  /** Largest answer read: a cart with its slots is a few tens of KB. */
  responseBytes: 1024 * 1024,
  /** Scene events kept while Gladys is unreachable. */
  queuedEvents: 100,
  /** Delivery ids remembered as already announced (in /data). */
  announced: 20,
};

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  requestTimeout: 20_000,
  /** The publisher sends what is pending every second. */
  flushInterval: 1_000,
  /** An unchanged state is sent again every 30 minutes. */
  stateHeartbeat: 30 * MINUTE,
  /** Delivery day: from 12 h before the slot, a read every 5 minutes. */
  dayLead: 12 * HOUR,
  dayInterval: 5 * MINUTE,
  /** Around the delivery: from 45 min before the slot (or ETA) to 30 min after it, every 2 minutes. */
  nearLead: 45 * MINUTE,
  nearLag: 30 * MINUTE,
  nearInterval: 2 * MINUTE,
  /** Never two cycles less than a minute apart. */
  minInterval: MINUTE,
  /** Pauses after a failed read: 2, 5, 10, 15, then 30 minutes. */
  backoff: [2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE],
  /** 429: Retry-After bounded to 1 minute .. 6 hours, 15 minutes without it. */
  rateLimitMin: MINUTE,
  rateLimitMax: 6 * HOUR,
  rateLimitDefault: 15 * MINUTE,
  /** A 403 that is not an authentication error (a CDN block): one hour. */
  forbiddenPause: HOUR,
  /** The "Test the connection" button reads Picnic at most this often. */
  testCooldown: 30_000,
  /** A verification code is requested at most once a minute. */
  codeCooldown: MINUTE,
  /** A sign-in waiting for its code is started again after this long. */
  pendingLifetime: 10 * MINUTE,
};
