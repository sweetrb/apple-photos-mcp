/**
 * Integration tests for apple-photos-mcp
 *
 * These run against a REAL osxphotos installation and the system Photos
 * library — no mocks. They exercise the full stack:
 * PhotosManager → Python (osxphotos) → the Photos library.
 *
 * All operations here are strictly READ-ONLY. Nothing is created, modified,
 * exported, or deleted.
 *
 * Prerequisites for the live portion:
 *   - macOS with osxphotos installed (and reachable via the project's venv)
 *   - A Photos library and the automation/Full Disk Access the reader needs
 *
 * The live block self-skips when `healthCheck()` reports not-ok (e.g. CI
 * runners with no library or no osxphotos), so this suite is safe to run
 * anywhere. The pure block needs no Photos library and always runs.
 *
 * Run via: npm run test:integration
 *   (or `npx vitest run --config vitest.integration.config.ts`)
 */

import { describe, it, expect, beforeAll } from "vitest";
import { PhotosManager } from "../src/services/photosManager.js";

let mgr: PhotosManager;
// True only when osxphotos + a real Photos library are reachable. When false,
// every test in the live block skips itself.
let live = false;

beforeAll(async () => {
  mgr = new PhotosManager();
  try {
    const health = await mgr.healthCheck();
    live = health.ok === true;
  } catch {
    // osxphotos / Photos unavailable — every live test will skip
    live = false;
  }
});

// ===========================================================================
// Pure — no Photos library required (always runs)
// ===========================================================================

describe("PhotosManager construction", () => {
  it("constructs without throwing", () => {
    expect(() => new PhotosManager()).not.toThrow();
  });

  it("exposes the read API surface", () => {
    const m = new PhotosManager();
    expect(typeof m.healthCheck).toBe("function");
    expect(typeof m.getLibraryInfo).toBe("function");
    expect(typeof m.query).toBe("function");
    expect(typeof m.getPhoto).toBe("function");
    expect(typeof m.getPhotos).toBe("function");
    expect(typeof m.getThumbnail).toBe("function");
    expect(typeof m.findDuplicates).toBe("function");
    expect(typeof m.listAlbums).toBe("function");
    expect(typeof m.listKeywords).toBe("function");
    expect(typeof m.listPersons).toBe("function");
  });
});

// ===========================================================================
// Live Photos library operations (self-skips when osxphotos/library absent)
// ===========================================================================

describe("live Photos library", { timeout: 120_000 }, () => {
  it("reports a healthy health-check with version + photo count", async (ctx) => {
    if (!live) ctx.skip();
    const health = await mgr.healthCheck();
    expect(health.ok).toBe(true);
    // Message embeds "osxphotos <version>, library <path> (<n> photos)".
    expect(health.message).toMatch(/osxphotos/i);
    expect(health.message).toMatch(/\d+\s+photos/i);
  });

  it("returns library info with a path and a non-negative photo count", async (ctx) => {
    if (!live) ctx.skip();
    const info = await mgr.getLibraryInfo();
    expect(typeof info.libraryPath).toBe("string");
    expect(info.libraryPath.length).toBeGreaterThan(0);
    expect(typeof info.photoCount).toBe("number");
    expect(info.photoCount).toBeGreaterThanOrEqual(0);
  });

  it("queries a small page of well-formed photo summaries", async (ctx) => {
    if (!live) ctx.skip();
    const result = await mgr.query({ limit: 3 });
    // count is the TOTAL match count; returned is the post-limit page size.
    expect(typeof result.count).toBe("number");
    expect(typeof result.returned).toBe("number");
    expect(result.returned).toBeLessThanOrEqual(3);
    expect(result.count).toBeGreaterThanOrEqual(result.returned);
    expect(Array.isArray(result.photos)).toBe(true);
    expect(result.photos.length).toBe(result.returned);
    for (const p of result.photos) {
      expect(typeof p.uuid).toBe("string");
      expect(p.uuid.length).toBeGreaterThan(0);
      expect(typeof p.filename).toBe("string");
      expect(typeof p.favorite).toBe("boolean");
    }
  });

  it("lists albums with a count and an array", async (ctx) => {
    if (!live) ctx.skip();
    const res = await mgr.listAlbums();
    expect(typeof res.count).toBe("number");
    expect(res.count).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(res.albums)).toBe(true);
  });

  it("lists keywords with a count and an array", async (ctx) => {
    if (!live) ctx.skip();
    const res = await mgr.listKeywords(5);
    expect(typeof res.count).toBe("number");
    expect(res.count).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(res.keywords)).toBe(true);
    expect(res.keywords.length).toBeLessThanOrEqual(5);
  });

  it("lists persons with a count and an array", async (ctx) => {
    if (!live) ctx.skip();
    const res = await mgr.listPersons(5);
    expect(typeof res.count).toBe("number");
    expect(res.count).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(res.persons)).toBe(true);
    expect(res.persons.length).toBeLessThanOrEqual(5);
  });

  it("fetches a single photo's detail by uuid (matching round-trip)", async (ctx) => {
    if (!live) ctx.skip();
    const result = await mgr.query({ limit: 1 });
    if (result.returned < 1) {
      // Empty library — nothing to round-trip, but the query itself worked.
      ctx.skip();
      return;
    }
    const uuid = result.photos[0].uuid;
    const detail = await mgr.getPhoto(uuid);
    expect(detail.uuid).toBe(uuid);
    // 1.5.0: detail carries the exif projection — an object or null, never absent.
    expect(detail).toHaveProperty("exif");
  });

  it("sorts newest-first before the limit slice (newestFirst)", async (ctx) => {
    if (!live) ctx.skip();
    const result = await mgr.query({ newestFirst: true, limit: 5 });
    if (result.returned < 2) {
      ctx.skip();
      return;
    }
    const dates = result.photos.map((p) => (p.date ? Date.parse(p.date) : -Infinity));
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
    }
  });

  it("filters by import-date window (addedInLast) with a plausible result", async (ctx) => {
    if (!live) ctx.skip();
    const recent = await mgr.query({ addedInLast: "365d", limit: 5 });
    const all = await mgr.query({ limit: 1 });
    // The trailing-year import window can never match MORE than the whole library.
    expect(recent.count).toBeLessThanOrEqual(all.count);
    expect(Array.isArray(recent.photos)).toBe(true);
  });

  it("filters by media type (screenshot) — every match carries the flag", async (ctx) => {
    if (!live) ctx.skip();
    const result = await mgr.query({ screenshot: true, limit: 3 });
    if (result.returned < 1) {
      ctx.skip();
      return;
    }
    const details = await mgr.getPhotos(result.photos.map((p) => p.uuid));
    for (const d of details.photos) {
      expect(d.isScreenshot).toBe(true);
    }
  });

  it("batch get-photos returns full detail for several uuids in one call and reports unknown uuids", async (ctx) => {
    if (!live) ctx.skip();
    const result = await mgr.query({ limit: 3 });
    if (result.returned < 1) {
      ctx.skip();
      return;
    }
    const uuids = result.photos.map((p) => p.uuid);
    const bogus = "00000000-0000-0000-0000-000000000000";
    const batch = await mgr.getPhotos([...uuids, bogus]);
    expect(batch.count).toBe(uuids.length);
    expect(batch.photos.map((p) => p.uuid)).toEqual(uuids);
    expect(batch.notFound).toEqual([bogus]);
    for (const p of batch.photos) {
      // Full detail shape (not the query summary) — including the exif key.
      expect(p).toHaveProperty("exif");
      expect(p).toHaveProperty("labels");
    }
  });

  it("returns a real decodable thumbnail image for a photo", async (ctx) => {
    if (!live) ctx.skip();
    // Prefer a non-missing still photo so a local derivative likely exists.
    const result = await mgr.query({ photos: true, newestFirst: true, limit: 10 });
    const candidate = result.photos.find((p) => !p.isMissing);
    if (!candidate) {
      ctx.skip();
      return;
    }
    const thumb = await mgr.getThumbnail(candidate.uuid);
    expect(thumb.uuid).toBe(candidate.uuid);
    expect(thumb.byteSize).toBeGreaterThan(0);
    expect(thumb.mimeType).toMatch(/^image\//);
    const bytes = Buffer.from(thumb.base64, "base64");
    expect(bytes.length).toBe(thumb.byteSize);
    // JPEG (ff d8 ff) or PNG (89 50 4e 47) magic — a real image, not junk.
    const magic = bytes.subarray(0, 4).toString("hex");
    expect(magic === "89504e47" || magic.startsWith("ffd8ff")).toBe(true);
    if (thumb.width !== null && thumb.height !== null) {
      expect(Math.max(thumb.width, thumb.height)).toBeGreaterThanOrEqual(1);
    }
  });

  it("find-duplicates returns well-formed groups (each with >= 2 members)", async (ctx) => {
    if (!live) ctx.skip();
    const result = await mgr.findDuplicates(5);
    expect(typeof result.groupCount).toBe("number");
    expect(result.returned).toBeLessThanOrEqual(5);
    expect(Array.isArray(result.groups)).toBe(true);
    for (const g of result.groups) {
      expect(g.count).toBeGreaterThanOrEqual(2);
      expect(g.uuids.length).toBe(g.count);
      expect(g.photos.length).toBe(g.count);
      for (const m of g.photos) {
        expect(typeof m.uuid).toBe("string");
        expect(typeof m.filename).toBe("string");
      }
    }
  });
});
