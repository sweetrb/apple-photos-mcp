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
 * Plus two races surfaced in review of the original PR and fixed before
 * merge — both exercise _db_write_epoch and the pre-parse mtime snapshot
 * that _store_db now checks instead of re-statting after the fact:
 *
 *   3. a write tool's cache invalidation landing WHILE a background refresh
 *      is in flight must not have its `.clear()` immediately undone by that
 *      refresh's _store_db writing the (now-stale, pre-write) parse back in;
 *   4. a second library mutation landing WHILE a background refresh is in
 *      flight must not let that refresh stamp its (still one-mutation-old)
 *      result as fresh just because the mtime it stats after finishing
 *      happens to match the newer change.
 *
 * Drives the REAL src/utils/photos_reader.py over its line-delimited JSON
 * protocol against the fake osxphotos (and, for the write-race test, the fake
 * photoscript write path), with FAKE_PHOTOSDB_PARSE_DELAY_S standing in for
 * the parse cost. Needs only a stock python3 — no osxphotos, no Photos
 * library, no Full Disk Access.
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
    JSON.stringify({ photos: { U1: { filename: "a.jpg", date: "2026-01-01T00:00:00" } } })
  );
  return { lib, sqlite };
}

type Envelope = {
  id?: number;
  type: string;
  dbCached?: boolean;
  dbStale?: boolean;
  error?: string;
};

/** A resident sidecar you can send commands to and await envelopes from. */
function startSidecar(lib: string, staleWhileRevalidate: boolean, enableWrites = false) {
  const proc = spawn("python3", [READER, "--serve"], {
    env: {
      ...process.env,
      PYTHONPATH: PYFAKES,
      FAKE_PHOTOSCRIPT_STATE: join(lib, "state.json"),
      FAKE_PHOTOS_LIBRARY_PATH: lib,
      FAKE_PHOTOSDB_PARSE_DELAY_S: String(PARSE_DELAY_S),
      ...(staleWhileRevalidate ? { APPLE_PHOTOS_MCP_STALE_WHILE_REVALIDATE: "1" } : {}),
      ...(enableWrites ? { APPLE_PHOTOS_MCP_ENABLE_WRITES: "1" } : {}),
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
  /** Send an arbitrary command and resolve with its envelope plus how long it
   *  took. Defaults to library-info — the cheapest command that goes through
   *  _open_db, and so the natural probe for cache state. */
  async function call(
    command = "library-info",
    args: string[] = []
  ): Promise<Envelope & { elapsedMs: number }> {
    const id = nextId++;
    const started = Date.now();
    const done = new Promise<Envelope>((r) => waiters.set(id, r));
    proc.stdin!.write(JSON.stringify({ id, command, args }) + "\n");
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

  it("a write landing during a background refresh is not undone by it", async () => {
    // _mark_library_written()'s _db_cache.clear() must win permanently over a
    // refresh that was already parsing when the write landed — otherwise the
    // refresh's _store_db call re-populates the cache with the pre-write
    // parse right after the write meant to invalidate it, making the write
    // invisible to the next read (dbCached true, dbStale false on data that
    // predates the write).
    const { lib, sqlite } = makeLibrary();
    const s = startSidecar(lib, true, /* enableWrites */ true);
    await s.readyPromise;

    const cold = await s.call();
    expect(cold.dbCached).toBe(false);
    const warm = await s.call();
    expect(warm.dbCached).toBe(true);
    expect(warm.dbStale).toBe(false);

    // Library changes — triggers the stale-serve-and-refresh path. The
    // refresh thread starts a PARSE_DELAY_MS-long parse in the background.
    const future = new Date(Date.now() + 2000);
    utimesSync(sqlite, future, future);
    const stale = await s.call();
    expect(stale.dbCached).toBe(true);
    expect(stale.dbStale).toBe(true);

    // Immediately — well before the refresh's parse can finish — a write
    // tool runs and calls _mark_library_written().
    const written = await s.call("set-photo-metadata", ["--uuid", "U1", "--favorite", "true"]);
    expect(written.error).toBeUndefined();

    // Let the in-flight refresh finish. Its parse predates the write, so it
    // must not be allowed to resurrect itself into the cache.
    await sleep(PARSE_DELAY_MS + 600);

    const after = await s.call();
    // The write's clear() must still be in effect: a full blocking re-parse,
    // not a cache hit serving the pre-write (and now falsely "fresh") data.
    expect(after.dbCached).toBe(false);
    expect(after.elapsedMs).toBeGreaterThanOrEqual(PARSE_DELAY_MS * 0.8);
  }, 30_000);

  it("a second mutation during a refresh is not reported as fresh once the refresh lands", async () => {
    // _store_db must stamp freshness against the mtime observed BEFORE the
    // parse started, not one read after the parse (and an unrelated later
    // mutation) completes — otherwise a mutation landing mid-refresh gets
    // silently absorbed: the refresh's result (parsed against the FIRST
    // change) reads as fully fresh (dbStale: false) as soon as it lands, even
    // though a SECOND change happened while it was still running.
    const { lib, sqlite } = makeLibrary();
    const s = startSidecar(lib, true);
    await s.readyPromise;

    const cold = await s.call();
    expect(cold.dbCached).toBe(false);
    const warm = await s.call();
    expect(warm.dbCached).toBe(true);
    expect(warm.dbStale).toBe(false);

    // First mutation — triggers stale-serve + background refresh #1, which
    // snapshots this mtime before it starts parsing.
    const change1 = new Date(Date.now() + 2000);
    utimesSync(sqlite, change1, change1);
    const stale1 = await s.call();
    expect(stale1.dbCached).toBe(true);
    expect(stale1.dbStale).toBe(true);

    // Second mutation, landing WHILE refresh #1 is still mid-parse.
    const change2 = new Date(Date.now() + 4000);
    utimesSync(sqlite, change2, change2);

    // Wait past refresh #1's completion, but not long enough for a chained
    // refresh #2 (spawned because #1 found the witness had moved again) to
    // have finished too.
    await sleep(PARSE_DELAY_MS + 200);
    const midway = await s.call();
    expect(midway.dbCached).toBe(true);
    // The crux of the fix: refresh #1's parse reflects the library as of
    // change1, not change2 — it must still report dbStale, not flip to fresh
    // just because change2 happens to be the mtime a naive post-parse stat
    // would have observed.
    expect(midway.dbStale).toBe(true);

    // Give the chained refresh #2 (snapshotting change2) time to land.
    await sleep(PARSE_DELAY_MS + 600);
    const converged = await s.call();
    expect(converged.dbCached).toBe(true);
    expect(converged.dbStale).toBe(false);
  }, 30_000);
});
