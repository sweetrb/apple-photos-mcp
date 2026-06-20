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

beforeAll(() => {
  mgr = new PhotosManager();
  try {
    const health = mgr.healthCheck();
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
    expect(typeof m.listAlbums).toBe("function");
    expect(typeof m.listKeywords).toBe("function");
    expect(typeof m.listPersons).toBe("function");
  });
});

// ===========================================================================
// Live Photos library operations (self-skips when osxphotos/library absent)
// ===========================================================================

describe("live Photos library", { timeout: 120_000 }, () => {
  it("reports a healthy health-check with version + photo count", (ctx) => {
    if (!live) ctx.skip();
    const health = mgr.healthCheck();
    expect(health.ok).toBe(true);
    // Message embeds "osxphotos <version>, library <path> (<n> photos)".
    expect(health.message).toMatch(/osxphotos/i);
    expect(health.message).toMatch(/\d+\s+photos/i);
  });

  it("returns library info with a path and a non-negative photo count", (ctx) => {
    if (!live) ctx.skip();
    const info = mgr.getLibraryInfo();
    expect(typeof info.libraryPath).toBe("string");
    expect(info.libraryPath.length).toBeGreaterThan(0);
    expect(typeof info.photoCount).toBe("number");
    expect(info.photoCount).toBeGreaterThanOrEqual(0);
  });

  it("queries a small page of well-formed photo summaries", (ctx) => {
    if (!live) ctx.skip();
    const result = mgr.query({ limit: 3 });
    expect(typeof result.count).toBe("number");
    expect(result.count).toBeLessThanOrEqual(3);
    expect(Array.isArray(result.photos)).toBe(true);
    expect(result.photos.length).toBe(result.count);
    for (const p of result.photos) {
      expect(typeof p.uuid).toBe("string");
      expect(p.uuid.length).toBeGreaterThan(0);
      expect(typeof p.filename).toBe("string");
      expect(typeof p.favorite).toBe("boolean");
    }
  });

  it("lists albums with a count and an array", (ctx) => {
    if (!live) ctx.skip();
    const res = mgr.listAlbums();
    expect(typeof res.count).toBe("number");
    expect(res.count).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(res.albums)).toBe(true);
  });

  it("lists keywords with a count and an array", (ctx) => {
    if (!live) ctx.skip();
    const res = mgr.listKeywords(5);
    expect(typeof res.count).toBe("number");
    expect(res.count).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(res.keywords)).toBe(true);
    expect(res.keywords.length).toBeLessThanOrEqual(5);
  });

  it("lists persons with a count and an array", (ctx) => {
    if (!live) ctx.skip();
    const res = mgr.listPersons(5);
    expect(typeof res.count).toBe("number");
    expect(res.count).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(res.persons)).toBe(true);
    expect(res.persons.length).toBeLessThanOrEqual(5);
  });

  it("fetches a single photo's detail by uuid (matching round-trip)", (ctx) => {
    if (!live) ctx.skip();
    const result = mgr.query({ limit: 1 });
    if (result.count < 1) {
      // Empty library — nothing to round-trip, but the query itself worked.
      ctx.skip();
      return;
    }
    const uuid = result.photos[0].uuid;
    const detail = mgr.getPhoto(uuid);
    expect(detail.uuid).toBe(uuid);
  });
});
