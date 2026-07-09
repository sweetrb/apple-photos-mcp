/**
 * Unit tests for the export-destination allowlist. The symlink/normalization
 * tests use the REAL filesystem under /tmp (an allowed root) because symlink
 * resolution is exactly the behavior under test.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ALLOWED_EXPORT_ROOTS,
  isPathWithinAllowedRoots,
  resolveExportDest,
} from "../utils/exportPath.js";

describe("isPathWithinAllowedRoots", () => {
  it("allows the roots themselves and paths strictly inside them", () => {
    expect(isPathWithinAllowedRoots(homedir())).toBe(true);
    expect(isPathWithinAllowedRoots(join(homedir(), "Desktop", "exports"))).toBe(true);
    expect(isPathWithinAllowedRoots("/tmp")).toBe(true);
    expect(isPathWithinAllowedRoots("/tmp/photos")).toBe(true);
    expect(isPathWithinAllowedRoots("/private/tmp/photos")).toBe(true);
    expect(isPathWithinAllowedRoots("/Volumes/USB/exports")).toBe(true);
  });

  it("rejects paths outside every root", () => {
    expect(isPathWithinAllowedRoots("/etc")).toBe(false);
    expect(isPathWithinAllowedRoots("/usr/local/bin")).toBe(false);
    expect(isPathWithinAllowedRoots("/Library/Preferences")).toBe(false);
    expect(isPathWithinAllowedRoots("/")).toBe(false);
  });

  it("rejects prefix-sharing siblings (segment-boundary check, not startsWith)", () => {
    expect(isPathWithinAllowedRoots("/Volumesx/evil")).toBe(false);
    expect(isPathWithinAllowedRoots("/tmpfoo")).toBe(false);
    expect(isPathWithinAllowedRoots(`${homedir()}x/evil`)).toBe(false);
  });

  it("includes the four documented roots", () => {
    expect(ALLOWED_EXPORT_ROOTS).toEqual([homedir(), "/tmp", "/private/tmp", "/Volumes"]);
  });
});

describe("resolveExportDest", () => {
  let scratch: string;

  beforeEach(() => {
    // Under /tmp deliberately — an allowed root, so the happy paths pass and
    // the symlink-escape test proves the escape is caught DESPITE starting
    // inside an allowed root.
    mkdirSync("/tmp", { recursive: true });
    scratch = mkdtempSync("/tmp/photos-mcp-export-");
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("expands ~ to the home directory", () => {
    const resolved = resolveExportDest("~/Desktop/photos-mcp-test-nonexistent");
    expect(resolved.startsWith(homedir())).toBe(true);
    expect(resolved.endsWith("/Desktop/photos-mcp-test-nonexistent")).toBe(true);
  });

  it("accepts a not-yet-existing directory under an allowed root", () => {
    const dest = join(scratch, "new", "nested", "dir");
    const resolved = resolveExportDest(dest);
    expect(isPathWithinAllowedRoots(resolved)).toBe(true);
    expect(resolved.endsWith(join("new", "nested", "dir"))).toBe(true);
  });

  it("normalizes .. segments before checking", () => {
    // Escapes /tmp via .. — must be rejected on the RESOLVED path.
    expect(() => resolveExportDest("/tmp/../etc/photos")).toThrow(/allowed export roots/);
  });

  it("rejects destinations outside the allowlist, naming the roots", () => {
    expect(() => resolveExportDest("/etc/photos")).toThrow(
      /home directory, \/tmp, \/private\/tmp, or \/Volumes/
    );
  });

  it("rejects a /Volumes prefix-sharing sibling", () => {
    expect(() => resolveExportDest("/Volumesx/evil")).toThrow(/allowed export roots/);
  });

  it("follows a symlink that escapes an allowed root and rejects it", () => {
    // /tmp/<scratch>/escape -> /etc ; dest "<scratch>/escape/photos" LOOKS
    // like it's under /tmp but actually writes into /etc/photos.
    const link = join(scratch, "escape");
    symlinkSync("/etc", link);
    expect(() => resolveExportDest(join(link, "photos"))).toThrow(/allowed export roots/);
  });

  it("follows a symlink that stays inside an allowed root and accepts it", () => {
    const realDir = join(scratch, "real");
    mkdirSync(realDir);
    const link = join(scratch, "alias");
    symlinkSync(realDir, link);
    const resolved = resolveExportDest(join(link, "out"));
    expect(isPathWithinAllowedRoots(resolved)).toBe(true);
    expect(resolved.endsWith(join("real", "out"))).toBe(true);
  });

  it("canonicalizes macOS /tmp to /private/tmp (both are allowed)", () => {
    const resolved = resolveExportDest(join(scratch, "out"));
    expect(isPathWithinAllowedRoots(resolved)).toBe(true);
  });
});
