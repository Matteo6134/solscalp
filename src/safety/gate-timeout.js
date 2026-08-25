/**
 * Timeout + cancellation primitives for the safety gate.
 *
 * A timeout is NEVER a pass. These helpers only ever reject; it is the
 * orchestrator's job to turn that rejection into errored(...), which under
 * SAFETY.failClosed reads as a REJECT.
 */

/** Marker on errors produced by an expired budget, so callers can label facts. */
export const TIMEOUT_CODE = 'GATE_TIMEOUT';
/** Marker for cancellation coming from the caller's own AbortSignal. */
export const ABORT_CODE = 'GATE_ABORTED';

/**
 * @param {string} message
 * @param {string} [code]
 * @returns {Error} an Error carrying `.code`, so no Error subclass is needed
 */
export function timeoutError(message, code = TIMEOUT_CODE) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** @param {unknown} err */
export const isTimeoutError = (err) =>
  Boolean(err) && typeof err === 'object' && /** @type {any} */ (err).code === TIMEOUT_CODE;

/** @param {unknown} err */
export const isAbortError = (err) =>
  Boolean(err) &&
  typeof err === 'object' &&
  (/** @type {any} */ (err).code === ABORT_CODE || /** @type {any} */ (err).name === 'AbortError');

/**
 * A monotonic wall-clock budget. Read-only view; nothing here mutates.
 * @param {number} totalMs
 * @param {() => number} now
 */
export function createBudget(totalMs, now) {
  const startedAt = now();
  return Object.freeze({
    startedAt,
    totalMs,
    elapsedMs: () => Math.max(0, now() - startedAt),
    remainingMs: () => totalMs - Math.max(0, now() - startedAt),
    expired: () => totalMs - Math.max(0, now() - startedAt) <= 0,
  });
}

/**
 * Run `fn(signal)` under a hard deadline, linked to an optional parent signal.
 *
 * The returned promise rejects with a timeout error the instant the budget
 * expires; it does not wait for `fn` to notice the abort. A slow layer can
 * therefore never hang the gate, only waste its own resources in the background
 * (which is why `signal` is handed to it: well-behaved fetchers bail at once).
 *
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>|T} fn
 * @param {object} opts
 * @param {number} opts.timeoutMs        hard budget; <= 0 rejects immediately
 * @param {AbortSignal} [opts.parentSignal] caller cancellation
 * @param {string} [opts.label]          used in the timeout message
 * @param {(err: unknown) => void} [opts.onLateError] receives a rejection that
 *   arrives after the race was already decided, so it is never swallowed silently
 * @returns {Promise<T>}
 */
export function withTimeout(fn, { timeoutMs, parentSignal, label = 'operation', onLateError } = {}) {
  if (typeof fn !== 'function') {
    return Promise.reject(new TypeError('withTimeout requires a function'));
  }
  if (!Number.isFinite(timeoutMs)) {
    return Promise.reject(new TypeError(`withTimeout requires a finite timeoutMs (got ${timeoutMs})`));
  }
  if (timeoutMs <= 0) {
    return Promise.reject(
      timeoutError(`${label} had no time budget left (${timeoutMs}ms)`),
    );
  }
  if (parentSignal?.aborted) {
    return Promise.reject(
      timeoutError(`${label} aborted before it started: ${reasonText(parentSignal.reason)}`, ABORT_CODE),
    );
  }

  const controller = new AbortController();
  const expiry = timeoutError(`${label} timed out after ${timeoutMs}ms`);

  /** @type {(err: unknown) => void} */
  let rejectRace = () => {};
  const tripwire = new Promise((_resolve, reject) => {
    rejectRace = reject;
  });

  // Deliberately NOT unref'd: an unref'd timer lets the process exit instead of
  // firing, which would turn a hung layer into a silent exit rather than an
  // ERROR verdict. It is always cleared in the finally below, so it only holds
  // the event loop while a layer is genuinely in flight.
  const timer = setTimeout(() => {
    controller.abort(expiry);
    rejectRace(expiry);
  }, timeoutMs);

  const onParentAbort = () => {
    const err = timeoutError(
      `${label} aborted by caller: ${reasonText(parentSignal?.reason)}`,
      ABORT_CODE,
    );
    controller.abort(err);
    rejectRace(err);
  };
  parentSignal?.addEventListener('abort', onParentAbort, { once: true });

  const work = (async () => fn(controller.signal))();
  // The race may be decided by the tripwire; the loser must still be observed
  // or Node reports an unhandled rejection.
  work.catch((err) => {
    if (typeof onLateError === 'function') onLateError(err);
  });

  return Promise.race([work, tripwire]).finally(() => {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onParentAbort);
  });
}

/** @param {unknown} reason */
function reasonText(reason) {
  if (reason === undefined || reason === null) return 'no reason given';
  if (reason instanceof Error) return reason.message;
  return String(reason);
}
