/**
 * Unit tests for the cross-process venv-bootstrap lock. These use the REAL
 * filesystem (in a private temp dir) on purpose: the whole point of the mkdir
 * lock is the atomicity the OS provides, so mocking fs would test nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireSetupLock,
  releaseSetupLock,
  sleepSyncMs,
  waitForCompletion,
} from "../utils/setupLock.js";

const STALE_MS = 60_000;

let base: string;
let lockDir: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "photos-mcp-lock-"));
  lockDir = join(base, "venv.setup.lock");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("acquireSetupLock", () => {
  it("acquires when no lock exists and creates the lock dir with a pid breadcrumb", () => {
    expect(acquireSetupLock(lockDir, STALE_MS)).toBe(true);
    expect(existsSync(lockDir)).toBe(true);
    expect(existsSync(join(lockDir, "pid"))).toBe(true);
  });

  it("refuses when a fresh lock is already held", () => {
    expect(acquireSetupLock(lockDir, STALE_MS)).toBe(true);
    expect(acquireSetupLock(lockDir, STALE_MS)).toBe(false);
  });

  it("acquires again after the holder releases", () => {
    expect(acquireSetupLock(lockDir, STALE_MS)).toBe(true);
    releaseSetupLock(lockDir);
    expect(existsSync(lockDir)).toBe(false);
    expect(acquireSetupLock(lockDir, STALE_MS)).toBe(true);
  });

  it("takes over a stale lock left behind by a dead process", () => {
    expect(acquireSetupLock(lockDir, STALE_MS)).toBe(true);
    // Backdate the lock dir past the staleness threshold, as if its holder
    // was SIGKILLed long ago and never released.
    const past = (Date.now() - 2 * STALE_MS) / 1000;
    utimesSync(lockDir, past, past);
    expect(acquireSetupLock(lockDir, STALE_MS)).toBe(true);
    // The takeover re-created the dir, so its mtime is fresh again.
    expect(Date.now() - statSync(lockDir).mtimeMs).toBeLessThan(STALE_MS);
  });

  it("does NOT take over a lock younger than the staleness threshold", () => {
    expect(acquireSetupLock(lockDir, STALE_MS)).toBe(true);
    // Slightly aged, but well within the threshold.
    const recent = (Date.now() - 1_000) / 1000;
    utimesSync(lockDir, recent, recent);
    expect(acquireSetupLock(lockDir, STALE_MS)).toBe(false);
  });

  it("returns false when the lock path is not creatable", () => {
    expect(acquireSetupLock(join(base, "no", "such", "parent", "lock"), STALE_MS)).toBe(false);
  });
});

describe("releaseSetupLock", () => {
  it("is a no-op on an already-released lock", () => {
    expect(() => releaseSetupLock(lockDir)).not.toThrow();
  });
});

describe("waitForCompletion", () => {
  it("returns true immediately when already complete (no sleeping)", () => {
    const start = Date.now();
    expect(waitForCompletion(() => true, 5_000, 1_000)).toBe(true);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("polls until the condition flips true", () => {
    let calls = 0;
    const ok = waitForCompletion(
      () => {
        calls += 1;
        return calls >= 3;
      },
      2_000,
      10
    );
    expect(ok).toBe(true);
    expect(calls).toBe(3);
  });

  it("returns false when the condition never completes within the timeout", () => {
    const start = Date.now();
    expect(waitForCompletion(() => false, 100, 10)).toBe(false);
    // Bounded: it gave up around the timeout, not much later.
    expect(Date.now() - start).toBeLessThan(2_000);
  });
});

describe("sleepSyncMs", () => {
  it("blocks for at least the requested duration", () => {
    const start = Date.now();
    sleepSyncMs(30);
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });
});
