/**
 * Sliding-window rate limiter. Shared by every data client in src/data.
 *
 * The free tiers this bot lives on publish HARD per-minute limits (LIMITS in
 * src/config.js). Blowing one gets the whole bot throttled, which is a silent
 * outage of the safety gate -- so this limiter is written to be CORRECT, not
 * best-effort:
 *
 *  - It QUEUES work instead of rejecting it. A caller never has to retry, and
 *    a retry loop can therefore never become the thing that trips the limit.
 *  - It counts a CLOSED window [now - windowMs, now]: a slot whose start is
 *    exactly windowMs old still counts, and the limiter waits one extra
 *    millisecond past it. No 60-second interval can ever contain more than
 *    `requestsPerMinute` starts, not even at the boundary.
 *  - It is deterministic: no jitter, no Math.random, strict FIFO. A test with
 *    fake timers sees exactly one possible behaviour.
 *  - One internal pump owns all the waiting, so N queued callers create one
 *    timer instead of a thundering herd that wakes together and bursts.
 *
 * The limiter caps request STARTS, not concurrency: a slow response must not
 * stall the queue behind it. Pair it with p-limit if you also need a
 * concurrency cap.
 *
 * Internal state is private to the closure and never handed out; every object
 * that leaves this module is frozen.
 */

/** The "minute" in requestsPerMinute. A unit conversion, not a tunable. */
const WINDOW_MS = 60_000;

/** Real clock. Overridable purely as a test seam; production never passes one. */
const defaultClock = Object.freeze({
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
});

/**
 * @typedef {object} RateLimiter
 * @property {string} label
 * @property {number} requestsPerMinute
 * @property {<T>(fn: () => (T | Promise<T>)) => Promise<T>} schedule
 * @property {() => Readonly<{label: string, requestsPerMinute: number, windowMs: number, queued: number, usedInWindow: number}>} stats
 */

/**
 * @param {object} p
 * @param {number} p.requestsPerMinute hard limit, from LIMITS in src/config.js
 * @param {string} [p.label] appears in every error message this limiter raises
 * @param {number} [p.windowMs] window length; only change it in tests
 * @param {{now: () => number, sleep: (ms: number) => Promise<void>}} [p.clock]
 * @returns {RateLimiter}
 */
export function createRateLimiter({
  requestsPerMinute,
  label = 'rate-limiter',
  windowMs = WINDOW_MS,
  clock = defaultClock,
} = {}) {
  if (!Number.isInteger(requestsPerMinute) || requestsPerMinute < 1) {
    throw new TypeError(
      `${label}: requestsPerMinute must be a positive integer, got ${String(requestsPerMinute)}`,
    );
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new TypeError(`${label}: windowMs must be a positive number, got ${String(windowMs)}`);
  }
  const { now, sleep } = clock ?? {};
  if (typeof now !== 'function' || typeof sleep !== 'function') {
    throw new TypeError(`${label}: clock must provide now() and sleep(ms)`);
  }

  /** @type {readonly number[]} start times of granted slots, ascending. */
  let granted = Object.freeze([]);
  /** @type {readonly Readonly<{run: Function, resolve: Function, reject: Function}>[]} FIFO */
  let queue = Object.freeze([]);
  /** Only one pump may own the waiting at a time. */
  let pumping = false;

  /** Slots still inside the closed window ending at `at`. */
  const liveAt = (at) => granted.filter((ts) => ts >= at - windowMs);

  /**
   * Milliseconds to wait before another slot may be granted; 0 when one is
   * free right now. Also drops slots that have aged out of the window.
   */
  function msUntilSlotFree() {
    const at = now();
    const live = liveAt(at);
    if (live.length !== granted.length) granted = Object.freeze(live);
    if (live.length < requestsPerMinute) return 0;
    // +1ms so the oldest slot is strictly outside the CLOSED window on retry.
    return live[0] + windowMs - at + 1;
  }

  /** Consume a slot and start the task. Never awaited: we cap starts, not concurrency. */
  function grant(task) {
    granted = Object.freeze([...granted, now()]);
    Promise.resolve()
      .then(() => task.run())
      .then(task.resolve, task.reject);
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length > 0) {
        const wait = msUntilSlotFree();
        if (wait > 0) {
          await sleep(wait);
          continue;
        }
        const [next, ...rest] = queue;
        queue = Object.freeze(rest);
        grant(next);
      }
    } catch (err) {
      // Only a broken clock/timer reaches here. Queued callers must be told:
      // stranding them silently would look like a hung check, and a hung
      // check is exactly what fail-closed exists to prevent.
      const stranded = queue;
      queue = Object.freeze([]);
      const reason = new Error(`${label}: limiter stopped scheduling: ${err?.message ?? err}`);
      reason.cause = err;
      for (const task of stranded) task.reject(reason);
    } finally {
      pumping = false;
    }
  }

  /**
   * Queue `fn` and resolve with its result once a slot is free.
   * Rejects with whatever `fn` throws (synchronously or not).
   * @template T
   * @param {() => (T | Promise<T>)} fn
   * @returns {Promise<T>}
   */
  function schedule(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError(`${label}: schedule(fn) requires a function, got ${typeof fn}`);
    }
    return new Promise((resolve, reject) => {
      queue = Object.freeze([...queue, Object.freeze({ run: fn, resolve, reject })]);
      void pump();
    });
  }

  /** Snapshot for logging. Never used for control flow. */
  const stats = () =>
    Object.freeze({
      label,
      requestsPerMinute,
      windowMs,
      queued: queue.length,
      usedInWindow: liveAt(now()).length,
    });

  return Object.freeze({ label, requestsPerMinute, schedule, stats });
}
