/**
 * PhotosDB cache revalidation contract.
 *
 * _open_db caches a parsed PhotosDB per library and revalidates it against
 * <library>/database/Photos.sqlite's mtime on EVERY call. On a large library
 * that re-parse costs minutes, so any write to the library — a phone sync, an
 * edit, Photos.app housekeeping — makes the NEXT request pay full freight.
 *
 * APPLE_PHOTOS_MCP_STALE_WHILE_REVALIDATE=1 opts into serving the previous
 * parse immediately and refreshing on a background thread. This suite pins
 * both halves of that contract:
 *
 *   1. default OFF — a changed library still blocks and re-parses (dbCached
 *      false), exactly as before;
 *   2. opt-in ON — a changed library answers from the stale parse without
 *      blocking (dbCached true + dbStale true), and a later request sees the
 *      refreshed parse (dbStale false).
 *
 * Drives the REAL src/utils/photos_reader.py over its line-delimited JSON
 * protocol against the fake osxphotos, with FAKE_PHOTOSDB_PARSE_DELAY_S
 * standing in for the parse cost. Needs only a stock python3 — no osxphotos,
 * no Photos library, no Full Disk Access.
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const READER = resolve(__dirname, "../src/utils/photos_reader.py");
const PYFAKES = resolve(__dirname, "fixtures/pyfakes");

/** Simulated PhotosDB parse cost. Long enough that a blocking re-parse is
 *  unmistakably distinguishable from a stale serve, short enough to be cheap. */
const PARSE_DELAY_S = 0.6;
const PARSE_DELAY_MS = PARSE_DELAY_S * 1000;

const dirs: string[] = [];
const procs: ChildProcess[] = [];

afterAll(() => {
  for (const p of procs) p.kill();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function makeLibrary(): { lib: string; sqlite: string } {
  const lib = mkdtempSync(join(tmpdir(), "photosdb-cache-"));
  dirs.push(lib);
  mkdirSync(join(lib, "database"));
  const sqlite = join(lib, "database", "Photos.sqlite");
  writeFileSync(sqlite, "x");
  writeFileSync(
    join(lib, "state.json"),
    JSON.stringify({ photos: { U1: { filename: "a.jpg", date: "2026-01-01T00:00:00" } } }),
  );
  return { lib, sqlite };
}

type Envelope = { id?: number; type: string; dbCached?: boolean; dbStale?: boolean; error?: string };

/** A resident sidecar you can send commands to and await envelopes from. */
function startSidecar(lib: string, staleWhileRevalidate: boolean) {
  const proc = spawn("python3", [READER, "--serve"], {
    env: {
      ...process.env,
      PYTHONPATH: PYFAKES,
      FAKE_PHOTOSCRIPT_STATE: join(lib, "state.json"),
      FAKE_PHOTOS_LIBRARY_PATH: lib,
      FAKE_PHOTOSDB_PARSE_DELAY_S: String(PARSE_DELAY_S),
      ...(staleWhileRevalidate ? { APPLE_PHOTOS_MCP_STALE_WHILE_REVALIDATE: "1" } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  procs.push(proc);

  const waiters = new Map<number, (e: Envelope) => void>();
  let ready: () => void;
  const readyPromise = new Promise<void>((r) => (ready = r));
  let buf = "";

  proc.stdout!.on("data", (chunk) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let env: Envelope;
      try {
        env = JSON.parse(line);
      } catch {
        continue;
      }
      if (env.type === "ready") ready();
      else if (env.id !== undefined && waiters.has(env.id)) {
        waiters.get(env.id)!(env);
        waiters.delete(env.id);
      }
    }
  });

  let nextId = 1;
  /** Send library-info — the cheapest command that goes through _open_db —
   *  and resolve with its envelope plus how long it took. */
  async function call(): Promise<Envelope & { elapsedMs: number }> {
    const id = nextId++;
    const started = Date.now();
    const done = new Promise<Envelope>((r) => waiters.set(id, r));
    proc.stdin!.write(JSON.stringify({ id, command: "library-info", args: [] }) + "\n");
    const env = await done;
    return { ...env, elapsedMs: Date.now() - started };
  }

  return { readyPromise, call, proc };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("PhotosDB cache revalidation", () => {
  it("by default, a changed library blocks and re-parses", async () => {
    const { lib, sqlite } = makeLibrary();
    const s = startSidecar(lib, false);
    await s.readyPromise;

    const cold = await s.call();
    expect(cold.error).toBeUndefined();
    expect(cold.dbCached).toBe(false);

    const warm = await s.call();
    expect(warm.dbCached).toBe(true);
    expect(warm.dbStale).toBe(false);

    // Library changes.
    const future = new Date(Date.now() + 2000);
    utimesSync(sqlite, future, future);

    const afterChange = await s.call();
    // Unchanged contract: full re-parse on the caller's thread.
    expect(afterChange.dbCached).toBe(false);
    expect(afterChange.dbStale).toBe(false);
    expect(afterChange.elapsedMs).toBeGreaterThanOrEqual(PARSE_DELAY_MS * 0.8);
  }, 30_000);

  it("with the opt-in, a changed library serves stale and refreshes behind it", async () => {
    const { lib, sqlite } = makeLibrary();
    const s = startSidecar(lib, true);
    await s.readyPromise;

    const cold = await s.call();
    expect(cold.error).toBeUndefined();
    expect(cold.dbCached).toBe(false);
    expect(cold.dbStale).toBe(false);

    const warm = await s.call();
    expect(warm.dbCached).toBe(true);
    expect(warm.dbStale).toBe(false);

    // Library changes.
    const future = new Date(Date.now() + 2000);
    utimesSync(sqlite, future, future);

    const stale = await s.call();
    expect(stale.dbCached).toBe(true);
    expect(stale.dbStale).toBe(true);
    // The whole point: answered from the stale parse rather than blocking.
    expect(stale.elapsedMs).toBeLessThan(PARSE_DELAY_MS * 0.5);

    // Let the background refresh land, then confirm it was swapped in.
    await sleep(PARSE_DELAY_MS + 600);
    const refreshed = await s.call();
    expect(refreshed.dbCached).toBe(true);
    expect(refreshed.dbStale).toBe(false);
  }, 30_000);
});
