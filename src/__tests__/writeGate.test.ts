import { describe, expect, it } from "vitest";
import {
  WRITES_ENV,
  assertWritesEnabled,
  writesDisabledMessage,
  writesEnabled,
} from "../utils/writeGate.js";

describe("writeGate", () => {
  describe("writesEnabled", () => {
    it.each([
      ["1", true],
      ["true", true],
      ["TRUE", true],
      ["yes", true], // any non-falsy token opts in (mirrors isTrueish elsewhere)
      ["0", false],
      ["false", false],
      ["FALSE", false],
      ["", false],
    ])("value %j → %s", (value, expected) => {
      expect(writesEnabled({ [WRITES_ENV]: value })).toBe(expected);
    });

    it("is disabled when the variable is absent (the read-only default)", () => {
      expect(writesEnabled({})).toBe(false);
    });
  });

  describe("assertWritesEnabled", () => {
    it("throws the gated-off message when disabled", () => {
      expect(() => assertWritesEnabled({})).toThrow(/read-only by default/);
      expect(() => assertWritesEnabled({})).toThrow(writesDisabledMessage());
    });

    it("does not throw when enabled", () => {
      expect(() => assertWritesEnabled({ [WRITES_ENV]: "1" })).not.toThrow();
    });
  });

  describe("writesDisabledMessage", () => {
    it("tells the user exactly how to opt in (env var, config.json, restart, doctor, docs)", () => {
      const msg = writesDisabledMessage();
      expect(msg).toContain("APPLE_PHOTOS_MCP_ENABLE_WRITES=1");
      expect(msg).toContain("config.json");
      expect(msg).toMatch(/restart/i);
      expect(msg).toMatch(/doctor/);
      expect(msg).toContain("https://github.com/sweetrb/apple-photos-mcp#write-tools-opt-in");
    });
  });
});
