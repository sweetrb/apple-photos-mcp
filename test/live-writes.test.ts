/**
 * LIVE write-tool tests — these MODIFY the real Photos library and therefore
 * require an explicit double opt-in:
 *
 *   APPLE_PHOTOS_MCP_LIVE_WRITE_TEST=1 pnpm run test:integration -- test/live-writes.test.ts
 *
 * (The suite enables APPLE_PHOTOS_MCP_ENABLE_WRITES itself; without the
 * LIVE_WRITE_TEST flag every test self-skips, so this file is safe in CI and
 * in a default `test:integration` run.)
 *
 * What it does — and undoes — on the live library:
 *   1. creates the album "MCP Write Test 2.0.0" (and proves create is
 *      idempotent),
 *   2. adds two existing photos to it (and proves add is idempotent),
 *   3. round-trips a keyword (add → verify union semantics → remove) on one
 *      of them, restoring the original keywords,
 *   4. round-trips the title on the same photo, restoring the original,
 *   5. removes one photo from the album (album rebuild — UUID change),
 *   6. verifies the album is visible to the osxphotos READ path (cache
 *      invalidation + sidecar re-parse, end-to-end),
 *   7. afterAll: deletes the test album and force-restores the photo's
 *      title/keywords via photoscript directly — deletion is deliberately NOT
 *      an MCP tool, so cleanup goes straight at the backend.
 *
 * Requires: macOS, a signed-in Photos library, Full Disk Access, and macOS
 * Automation permission for Photos (the first write may pop the TCC prompt).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PhotosManager } from "../src/services/photosManager.js";

const LIVE = process.env.APPLE_PHOTOS_MCP_LIVE_WRITE_TEST === "1";
const TEST_ALBUM = "MCP Write Test 2.0.0";
const TEST_KEYWORD = "mcp-live-write-test";
const TEST_TITLE = "MCP Live Write Test Title";
const VENV_PYTHON = resolve(__dirname, "../venv/bin/python3");

let mgr: PhotosManager;
let ready = false;
let photoA: string; // keyword/title round-trip target
let photoB: string;
let originalKeywords: string[] | null = null;
let originalTitle: string | null = null;
let keywordsRestored = false;
let titleRestored = false;
let albumUuid: string | null = null;

beforeAll(async () => {
  if (!LIVE) return;
  process.env.APPLE_PHOTOS_MCP_ENABLE_WRITES = "1";
  mgr = new PhotosManager();
  const health = await mgr.healthCheck();
  if (!health.ok) return;
  // Two real, present photos to file into the test album.
  const result = await mgr.query({ photos: true, newestFirst: true, limit: 10 });
  const candidates = result.photos.filter((p) => !p.isMissing);
  if (candidates.length < 2) return;
  photoA = candidates[0].uuid;
  photoB = candidates[1].uuid;
  ready = true;
}, 180_000);

afterAll(async () => {
  if (!LIVE || !ready || !existsSync(VENV_PYTHON)) return;
  // Full cleanup via photoscript DIRECTLY (album deletion is deliberately not
  // an MCP tool): delete every album named TEST_ALBUM, and force-restore the
  // photo's title/keywords if the in-test reverts didn't run.
  const cleanup = `
import json, sys
import photoscript
from photoscript.script_loader import configure_run_script
configure_run_script(retry_enabled=False)
spec = json.loads(sys.argv[1])
lib = photoscript.PhotosLibrary()
deleted = 0
album = lib.album(spec["album"])
while album is not None:
    lib.delete_album(album)
    deleted += 1
    album = lib.album(spec["album"])
restored = []
if spec.get("uuid"):
    p = photoscript.Photo(spec["uuid"])
    if spec.get("restoreKeywords") is not None:
        p.keywords = spec["restoreKeywords"]
        restored.append("keywords")
    if spec.get("restoreTitle") is not None:
        p.title = spec["restoreTitle"]
        restored.append("title")
print(json.dumps({"deletedAlbums": deleted, "restored": restored}))
`;
  const spec = {
    album: TEST_ALBUM,
    uuid: photoA ?? null,
    restoreKeywords: !keywordsRestored && originalKeywords !== null ? originalKeywords : null,
    restoreTitle: !titleRestored && originalTitle !== null ? originalTitle : null,
  };
  const out = execFileSync(VENV_PYTHON, ["-c", cleanup, JSON.stringify(spec)], {
    encoding: "utf-8",
    timeout: 300_000,
  });
  // Surface the cleanup result in the test output.
  console.log(`[live-writes cleanup] ${out.trim()}`);
}, 300_000);

describe("live write tools (opt-in: APPLE_PHOTOS_MCP_LIVE_WRITE_TEST=1)", () => {
  it("create-album creates the test album", async (ctx) => {
    if (!ready) ctx.skip();
    const result = await mgr.createAlbum(TEST_ALBUM);
    expect(result.album.name).toBe(TEST_ALBUM);
    expect(result.album.uuid.length).toBeGreaterThan(0);
    albumUuid = result.album.uuid;
    // created may be false if a previous aborted run left the album behind —
    // afterAll deletes it either way.
  }, 300_000);

  it("create-album is idempotent (same album, created=false)", async (ctx) => {
    if (!ready) ctx.skip();
    const again = await mgr.createAlbum(TEST_ALBUM);
    expect(again.created).toBe(false);
    expect(again.album.uuid).toBe(albumUuid);
  }, 300_000);

  it("add-to-album files two photos", async (ctx) => {
    if (!ready) ctx.skip();
    const result = await mgr.addToAlbum(TEST_ALBUM, [photoA, photoB]);
    expect(result.addedCount + result.alreadyPresent.length).toBe(2);
    expect(result.notFound).toEqual([]);
  }, 300_000);

  it("add-to-album is idempotent (both reported alreadyPresent)", async (ctx) => {
    if (!ready) ctx.skip();
    const again = await mgr.addToAlbum(TEST_ALBUM, [photoA, photoB]);
    expect(again.addedCount).toBe(0);
    expect(new Set(again.alreadyPresent)).toEqual(new Set([photoA, photoB]));
  }, 300_000);

  it("set-keywords adds a keyword with union semantics (existing keywords preserved)", async (ctx) => {
    if (!ready) ctx.skip();
    const result = await mgr.setKeywords(photoA, { add: [TEST_KEYWORD] });
    originalKeywords = result.before;
    expect(result.added).toEqual([TEST_KEYWORD]);
    expect(result.after).toEqual([...result.before, TEST_KEYWORD]);
    expect(result.changed).toBe(true);
  }, 300_000);

  it("set-keywords removes the keyword, restoring the original list exactly", async (ctx) => {
    if (!ready) ctx.skip();
    const result = await mgr.setKeywords(photoA, { remove: [TEST_KEYWORD] });
    expect(result.removed).toEqual([TEST_KEYWORD]);
    expect(result.after).toEqual(originalKeywords);
    keywordsRestored = true;
  }, 300_000);

  it("set-photo-metadata sets a title and echoes before/after", async (ctx) => {
    if (!ready) ctx.skip();
    const result = await mgr.setPhotoMetadata(photoA, { title: TEST_TITLE });
    originalTitle = result.before.title;
    expect(result.updated).toEqual(["title"]);
    expect(result.after.title).toBe(TEST_TITLE);
    expect(result.before.favorite).toBe(result.after.favorite); // untouched
  }, 300_000);

  it("set-photo-metadata reverts the title from the echoed before value", async (ctx) => {
    if (!ready) ctx.skip();
    const result = await mgr.setPhotoMetadata(photoA, { title: originalTitle ?? "" });
    expect(result.after.title).toBe(originalTitle ?? "");
    titleRestored = true;
  }, 300_000);

  it("remove-from-album removes one photo via the album rebuild (UUID changes)", async (ctx) => {
    if (!ready) ctx.skip();
    const result = await mgr.removeFromAlbum(TEST_ALBUM, [photoB]);
    expect(result.removedCount).toBe(1);
    expect(result.removed).toEqual([photoB]);
    expect(result.albumRecreated).toBe(true);
    expect(result.previousAlbumUuid).toBe(albumUuid);
    expect(result.album.uuid).not.toBe(albumUuid);
    albumUuid = result.album.uuid;
  }, 600_000);

  it("the READ path sees the mutated album (cache invalidation + sidecar re-parse)", async (ctx) => {
    if (!ready) ctx.skip();
    // Photos commits via SQLite WAL; osxphotos re-parses on the next read
    // because the write dropped both caches. Allow a few retries for Photos'
    // own commit/checkpoint latency.
    let seen: { title: string; photoCount: number } | undefined;
    for (let attempt = 0; attempt < 6; attempt++) {
      const { albums } = await mgr.listAlbums();
      seen = albums.find((a) => a.title === TEST_ALBUM);
      if (seen && seen.photoCount === 1) break;
      await new Promise((r) => setTimeout(r, 2500));
    }
    expect(seen, "test album not visible to the osxphotos read path").toBeDefined();
    expect(seen?.photoCount).toBe(1); // photoA remains; photoB was removed
  }, 300_000);
});
