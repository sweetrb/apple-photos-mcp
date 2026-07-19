import { describe, expect, it } from "vitest";

import { looksLikePermissionError } from "../utils/permissionErrors.js";

describe("looksLikePermissionError", () => {
  it("recognizes explicit macOS denials", () => {
    expect(looksLikePermissionError("Operation not permitted")).toBe(true);
    expect(looksLikePermissionError("unable to open database file")).toBe(true);
    expect(looksLikePermissionError("access denied")).toBe(true);
    expect(looksLikePermissionError("Full Disk Access required")).toBe(true);
  });

  it("recognizes osxphotos' 'Error copying …/Photos.sqlite' as an FDA denial", () => {
    expect(
      looksLikePermissionError(
        "Error copying/Users/x/Pictures/Photos Library.photoslibrary/database/Photos.sqlite " +
          "to /tmp/osxphotos_abcd1234/Photos.sqlite"
      )
    ).toBe(true);
    // Space after "Error copying" and mixed casing still match.
    expect(
      looksLikePermissionError("error copying /path/Photos.sqlite to /tmp/x/Photos.sqlite")
    ).toBe(true);
  });

  it("does not misclassify unrelated errors", () => {
    expect(looksLikePermissionError("library locked")).toBe(false);
    expect(looksLikePermissionError("timeout after 60000ms")).toBe(false);
    // A copy error that is not about Photos.sqlite is not FDA-flagged.
    expect(looksLikePermissionError("Error copying export.jpg to /tmp/out.jpg")).toBe(false);
  });
});
