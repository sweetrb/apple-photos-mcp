/**
 * Serial execution gate.
 *
 * Every Photos sidecar invocation spawns a python process that opens the
 * Photos SQLite database (and export may drive Photos.app). Running several at
 * once multiplies the full-library parse cost, races concurrent readers into
 * the same DB while Photos.app may be writing it, and lets one client fan out
 * unbounded python processes. A gate chains every task through a single
 * promise so only one sidecar runs at a time — preserving the strict
 * one-at-a-time semantics the old execFileSync layer had implicitly.
 *
 * Because tasks are chained on promises, awaiting the gate also yields the
 * event loop, keeping the server responsive to protocol traffic (pings,
 * health-check) while a long query or export runs. The `pending` counter lets
 * diagnostics (health-check, doctor) detect an in-flight sidecar operation and
 * answer from fast pure-TS paths instead of queueing behind it.
 *
 * Ported from apple-mail-mcp's utils/serialize (issue #11 there); the settle
 * delay defaults to 0 here because a spawn-per-call sidecar has no dispatch
 * queue to drain between tasks (unlike Mail.app's AppleScript handler).
 *
 * @module utils/serialize
 */

/** A function that serializes a task behind all previously enqueued tasks. */
export interface SerialGate {
  <R>(task: () => R | PromiseLike<R>): Promise<R>;
  /** Number of tasks currently running or queued behind the gate. */
  readonly pending: number;
}

/**
 * Creates a serial execution gate.
 *
 * @param settleMs - Delay inserted after each task before the next one starts
 *   (default 0 — no settle needed between independent sidecar spawns).
 * @returns A `serialize(task)` function. Tasks run strictly in enqueue order and
 *   never overlap; each call resolves/rejects with its task's own result, and a
 *   failing task never breaks serialization for later tasks. The function also
 *   exposes `pending`, the number of tasks running or queued.
 */
export function createSerialGate(settleMs = 0): SerialGate {
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;

  const gate = <R>(task: () => R | PromiseLike<R>): Promise<R> => {
    pending += 1;
    const result = tail.then(task);
    // Keep the chain alive regardless of this task's outcome, with an optional
    // settle delay before the next task starts.
    tail = result.then(
      () => {
        pending -= 1;
        return settle(settleMs);
      },
      () => {
        pending -= 1;
        return settle(settleMs);
      }
    );
    return result;
  };
  Object.defineProperty(gate, "pending", { get: () => pending });
  return gate as SerialGate;
}

function settle(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
