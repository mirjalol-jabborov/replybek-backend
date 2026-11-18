/**
 * The waiting room between a backgrounded answer and the browser that runs in-page requests.
 *
 * When an in-page tool runs, the answer saves a pending `tool_calls` row and `wait()`s on its id.
 * The widget (inside the business system's page) picks the row up by polling, runs the request
 * with the user's own session, and posts the result, which `deliver()` hands back to the waiter.
 * In-memory, so it covers one server process — which is how Replybek runs (WORKER_IN_PROCESS).
 */
const waiters = new Map(); // tool_call id → { resolve, timer }

export function wait(id, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      resolve({ timedOut: true });
    }, timeoutMs);
    waiters.set(id, { resolve, timer });
  });
}

/** Called when the browser posts a result. Returns false if nothing was waiting (already timed out). */
export function deliver(id, result) {
  const w = waiters.get(id);
  if (!w) return false;
  clearTimeout(w.timer);
  waiters.delete(id);
  w.resolve(result);
  return true;
}
