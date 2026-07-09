/**
 * Cross-process lock for the venv bootstrap.
 *
 * Multiple MCP hosts can spawn this server concurrently (the desktop app
 * starts one instance per conversation), and on a fresh install every
 * instance's first tool call tries to bootstrap the shared ./venv. Without a
 * lock, two concurrent `python -m venv` + `pip install` runs interleave in the
 * same directory and can leave a corrupted venv that then passes the
 * .deps-ok marker check.
 *
 * The lock is a directory created with `mkdirSync` — atomic on POSIX: exactly
 * one process succeeds, everyone else gets EEXIST. The winner runs setup; the
 * losers wait (bounded) for the winner's completion marker. A lock left behind
 * by a dead process (SIGKILL mid-setup) is taken over once it's older than a
 * staleness threshold.
 *
 * scripts/setup.sh implements the same protocol on the same lock directory for
 * manual invocations; the TS bootstrap passes APPLE_PHOTOS_MCP_SETUP_LOCK_HELD=1
 * so the script doesn't try to re-acquire the lock its parent already holds.
 *
 * @module utils/setupLock
 */
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Try to acquire the lock directory. Returns true when this process now holds
 * the lock. A held lock older than `staleMs` is presumed abandoned by a dead
 * process and taken over (removed, then re-acquired).
 */
export function acquireSetupLock(lockDir: string, staleMs: number): boolean {
  // At most two attempts: the second exists only for the stale-takeover path.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lockDir);
      try {
        // Best-effort breadcrumb for humans debugging a stuck lock.
        writeFileSync(join(lockDir, "pid"), `${process.pid}\n`);
      } catch {
        // The pid file is informational only.
      }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        // Unwritable parent, permissions, etc. — we cannot lock here.
        return false;
      }
      let ageMs: number;
      try {
        ageMs = Date.now() - statSync(lockDir).mtimeMs;
      } catch {
        // The holder released between our mkdir and stat — retry the mkdir.
        continue;
      }
      if (ageMs > staleMs) {
        // Abandoned by a dead process: remove and retry once.
        try {
          rmSync(lockDir, { recursive: true, force: true });
        } catch {
          return false;
        }
        continue;
      }
      return false;
    }
  }
  return false;
}

/** Release a lock acquired by acquireSetupLock. Never throws. */
export function releaseSetupLock(lockDir: string): void {
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // Nothing useful to do — a leftover lock is reclaimed via the stale path.
  }
}

/** Awaitable sleep — yields the event loop while waiting. */
function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `isComplete` until it returns true or `timeoutMs` elapses. Used by the
 * lock loser to wait for the winner's completion marker (venv .deps-ok).
 * Awaitable (the sidecar layer is async — a blocking wait here would freeze
 * the event loop and defeat the health-check-stays-responsive guarantee).
 * Resolves true when completion was observed, false on timeout.
 */
export async function waitForCompletion(
  isComplete: () => boolean,
  timeoutMs: number,
  pollMs = 1000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (isComplete()) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await sleepMs(Math.min(pollMs, remaining));
  }
}
