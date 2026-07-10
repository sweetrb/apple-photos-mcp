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
 *   7. (2.1.0) round-trips the photo's DATE: dry run (verifies nothing was
 *      written), real +1h shift, then revert from the echoed before value,
 *   8. (2.1.0) imports a freshly generated 100×100 random-pixel JPEG into a
 *      scratch album, titles it clearly, and verifies it round-trips,
 *   9. afterAll: deletes the test albums and force-restores the photo's
 *      title/keywords/date via photoscript directly — deletion is
 *      deliberately NOT an MCP tool, so cleanup goes straight at the backend.
 *
 * KNOWN RESIDUE: the imported test photo itself CANNOT be deleted
 * programmatically (Photos' AppleScript has no photo-delete verb). It is
 * titled "MCP live-import test — safe to delete" so it's easy to find and
 * remove by hand in Photos.app; each run generates unique random pixels, so
 * re-runs never trip Photos' duplicate dialog.
 *
 * Requires: macOS, a signed-in Photos library, Full Disk Access, and macOS
 * Automation permission for Photos (the first write may pop the TCC prompt).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { PhotosManager } from "../src/services/photosManager.js";

const LIVE = process.env.APPLE_PHOTOS_MCP_LIVE_WRITE_TEST === "1";
const TEST_ALBUM = "MCP Write Test 2.0.0";
const IMPORT_ALBUM = "MCP Import Test 2.1.0";
const TEST_KEYWORD = "mcp-live-write-test";
const TEST_TITLE = "MCP Live Write Test Title";
const IMPORT_TITLE = "MCP live-import test — safe to delete";
const VENV_PYTHON = resolve(__dirname, "../venv/bin/python3");

let mgr: PhotosManager;
let ready = false;
let photoA: string; // keyword/title/date round-trip target
let photoB: string;
let originalKeywords: string[] | null = null;
let originalTitle: string | null = null;
let originalDate: string | null = null;
let keywordsRestored = false;
let titleRestored = false;
let dateRestored = false;
let albumUuid: string | null = null;
let importedUuid: string | null = null;

/** Write a 100×100 random-pixel JPEG (unique every run) and return its path. */
function generateTestJpeg(): string {
  // Under /tmp, not os.tmpdir(): macOS's per-user temp (/var/folders/…) is
  // outside the import/export allowlist roots by design.
  const dir = mkdtempSync(join("/tmp", "mcp-import-live-"));
  const png = join(dir, "mcp-import-test.png");
  const jpg = join(dir, "mcp-import-test.jpg");
  const script = `
import os, struct, sys, zlib
path = sys.argv[1]
w = h = 100
raw = b"".join(b"\\x00" + os.urandom(3 * w) for _ in range(h))
def chunk(tag, data):
    body = tag + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))
ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
png = b"\\x89PNG\\r\\n\\x1a\\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
open(path, "wb").write(png)
`;
  execFileSync(VENV_PYTHON, ["-c", script, png], { timeout: 30_000 });
  execFileSync("/usr/bin/sips", ["-s", "format", "jpeg", png, "--out", jpg], {
    stdio: "pipe",
    timeout: 30_000,
  });
  return jpg;
}

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
from datetime import datetime
import photoscript
from photoscript.script_loader import configure_run_script
configure_run_script(retry_enabled=False)
spec = json.loads(sys.argv[1])
lib = photoscript.PhotosLibrary()
deleted = 0
for name in spec["albums"]:
    album = lib.album(name)
    while album is not None:
        lib.delete_album(album)
        deleted += 1
        album = lib.album(name)
restored = []
if spec.get("uuid"):
    p = photoscript.Photo(spec["uuid"])
    if spec.get("restoreKeywords") is not None:
        p.keywords = spec["restoreKeywords"]
        restored.append("keywords")
    if spec.get("restoreTitle") is not None:
        p.title = spec["restoreTitle"]
        restored.append("title")
    if spec.get("restoreDate") is not None:
        p.date = datetime.fromisoformat(spec["restoreDate"])
        restored.append("date")
print(json.dumps({"deletedAlbums": deleted, "restored": restored}))
`;
  const spec = {
    albums: [TEST_ALBUM, IMPORT_ALBUM],
    uuid: photoA ?? null,
    restoreKeywords: !keywordsRestored && originalKeywords !== null ? originalKeywords : null,
    restoreTitle: !titleRestored && originalTitle !== null ? originalTitle : null,
    restoreDate: !dateRestored && originalDate !== null ? originalDate : null,
  };
  const out = execFileSync(VENV_PYTHON, ["-c", cleanup, JSON.stringify(spec)], {
    encoding: "utf-8",
    timeout: 300_000,
  });
  // Surface the cleanup result in the test output. The imported test photo
  // cannot be deleted programmatically (no AppleScript photo-delete verb) —
  // report its identity so it can be removed by hand in Photos.app.
  console.log(`[live-writes cleanup] ${out.trim()}`);
  if (importedUuid !== null) {
    console.log(
      `[live-writes cleanup] imported test photo ${importedUuid} ("${IMPORT_TITLE}") ` +
        `remains in the library — Photos' AppleScript cannot delete photos; ` +
        `remove it by hand in Photos.app if desired.`
    );
  }
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

  // --- 2.1.0: set-photo-date (dry run → apply → revert) ---

  it("set-photo-date DRY RUN previews the shift and writes NOTHING", async (ctx) => {
    if (!ready) ctx.skip();
    const dry = await mgr.setPhotoDate(photoA, { shiftSeconds: 3600 }); // dryRun default
    expect(dry.dryRun).toBe(true);
    expect(dry.applied).toBe(false);
    expect(dry.shiftSeconds).toBe(3600);
    expect(Date.parse(dry.after) - Date.parse(dry.before)).toBe(3600_000);
    originalDate = dry.before;
    // Prove nothing was written: a second dry run sees the same before.
    const again = await mgr.setPhotoDate(photoA, { shiftSeconds: 3600 });
    expect(again.before).toBe(dry.before);
  }, 300_000);

  it("set-photo-date dryRun=false applies a real +1h shift", async (ctx) => {
    if (!ready) ctx.skip();
    const applied = await mgr.setPhotoDate(photoA, { shiftSeconds: 3600, dryRun: false });
    expect(applied.applied).toBe(true);
    expect(applied.dryRun).toBe(false);
    expect(applied.before).toBe(originalDate);
    expect(Date.parse(applied.after) - Date.parse(originalDate as string)).toBe(3600_000);
  }, 300_000);

  it("set-photo-date REVERTS from the echoed before value", async (ctx) => {
    if (!ready) ctx.skip();
    const reverted = await mgr.setPhotoDate(photoA, {
      date: originalDate as string,
      dryRun: false,
    });
    expect(reverted.applied).toBe(true);
    expect(reverted.after).toBe(originalDate);
    dateRestored = true;
  }, 300_000);

  // --- 2.1.0: import-photos (generated JPEG → scratch album → verify) ---

  it("import-photos imports a generated 100×100 JPEG into a scratch album", async (ctx) => {
    if (!ready) ctx.skip();
    const jpg = generateTestJpeg();
    await mgr.createAlbum(IMPORT_ALBUM);
    // Random pixel content makes every run unique, so the DEFAULT duplicate
    // check can stay on without risking Photos' blocking duplicate dialog.
    const result = await mgr.importPhotos([jpg], { album: IMPORT_ALBUM });
    expect(result.requestedCount).toBe(1);
    expect(result.importedCount).toBe(1);
    expect(result.album?.name).toBe(IMPORT_ALBUM);
    importedUuid = result.imported[0].uuid;
    expect(importedUuid.length).toBeGreaterThan(0);
    // Title it so the un-deletable residue is findable by hand (see header).
    const titled = await mgr.setPhotoMetadata(importedUuid, { title: IMPORT_TITLE });
    expect(titled.after.title).toBe(IMPORT_TITLE);
  }, 600_000);

  it("the imported photo round-trips through the osxphotos READ path", async (ctx) => {
    if (!ready || importedUuid === null) ctx.skip();
    // Retry for Photos' WAL checkpoint latency, like the album check above.
    let detail: { uuid: string; filename: string } | undefined;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        detail = await mgr.getPhoto(importedUuid as string);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 2500));
      }
    }
    expect(detail, "imported photo not visible to the osxphotos read path").toBeDefined();
    expect(detail?.uuid).toBe(importedUuid);
    expect(detail?.filename).toContain("mcp-import-test");
  }, 300_000);
});
