/**
 * Responsiveness contract — the acceptance test for the async sidecar flip
 * (1.3.0). Boots the REAL built server (build/index.js) over stdio against a
 * synthetic SLOW python sidecar and proves that the event loop stays free
 * while a sidecar command runs:
 *
 *   1. a `query` whose sidecar sleeps for several seconds is issued;
 *   2. one second later a `health-check` is issued;
 *   3. the health-check MUST resolve while the query is still in flight
 *      (fast pure-TS liveness path), and the query must then complete
 *      normally with its own result.
 *
 * With the old execFileSync layer this was impossible: the event loop was
 * frozen for the whole sidecar run, so the health-check response could only
 * arrive after the query finished.
 *
 * The synthetic sidecar lives in a temp "project layout" (package.json +
 * src/utils/photos_reader.py + a copy of build/index.js) so getProjectRoot()'s
 * walk-up finds it; it needs only a stock python3 — no osxphotos, no Photos
 * library, no Full Disk Access — so this suite runs anywhere, including CI.
 * Requires build/ (CI runs the build before test:integration).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REAL_BUILD = resolve(__dirname, "../build/index.js");

/** Seconds the fake sidecar sleeps on `query` — health-check fires at +1s. */
const QUERY_SLEEP_S = 4;

const FAKE_READER = `#!/usr/bin/env python3
"""Synthetic photos_reader for the responsiveness test: query is SLOW."""
import json
import sys
import time

cmd = sys.argv[1] if len(sys.argv) > 1 else ""
if cmd == "query":
    time.sleep(${QUERY_SLEEP_S})
    print(json.dumps({
        "count": 1,
        "returned": 1,
        "photos": [{
            "uuid": "FAKE-SLOW-UUID", "filename": "slow.jpg", "date": None,
            "title": None, "favorite": False, "hidden": False,
            "isMissing": False, "isPhoto": True, "isMovie": False,
            "width": 1, "height": 1, "albums": [], "keywords": [], "persons": []
        }]
    }))
elif cmd == "health":
    print(json.dumps({
        "ok": True, "osxphotosVersion": "0.0-fake",
        "libraryPath": "/fake.photoslibrary", "photoCount": 1
    }))
else:
    print(json.dumps({"error": "unsupported command in fake sidecar: " + cmd}))
    sys.exit(1)
`;

describe("server responsiveness during a slow sidecar call (real server over stdio)", () => {
  let client: Client;
  let layout: string;

  beforeAll(async () => {
    // Build the temp project layout the bundled server resolves itself against.
    layout = mkdtempSync(join(tmpdir(), "photos-mcp-responsiveness-"));
    mkdirSync(join(layout, "build"), { recursive: true });
    mkdirSync(join(layout, "src", "utils"), { recursive: true });
    copyFileSync(REAL_BUILD, join(layout, "build", "index.js"));
    writeFileSync(
      join(layout, "package.json"),
      JSON.stringify({ name: "apple-photos-mcp", version: "0.0.0-test", type: "module" })
    );
    writeFileSync(join(layout, "src", "utils", "photos_reader.py"), FAKE_READER);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(layout, "build", "index.js")],
      env: {
        ...process.env,
        // No venv in the layout -> system python3; never auto-bootstrap.
        APPLE_PHOTOS_MCP_NO_AUTO_SETUP: "1",
        // Isolate from any real user config.
        APPLE_PHOTOS_MCP_CONFIG_FILE: join(layout, "no-such-config.json"),
      } as Record<string, string>,
    });
    client = new Client({ name: "responsiveness-test", version: "0.0.0" });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    rmSync(layout, { recursive: true, force: true });
  });

  it(
    "health-check responds while a slow query is still running",
    async () => {
      const order: string[] = [];

      // 1. Fire the slow query (fake sidecar sleeps QUERY_SLEEP_S seconds).
      const slowQuery = client
        .callTool({ name: "query", arguments: {} })
        .then((r) => {
          order.push("query");
          return r;
        });

      // 2. One second later — squarely inside the sidecar sleep — ask for a
      //    health-check.
      await new Promise((r) => setTimeout(r, 1000));
      const healthStarted = Date.now();
      const health = (await client.callTool({ name: "health-check", arguments: {} }).then((r) => {
        order.push("health");
        return r;
      })) as {
        content: { type: string; text: string }[];
        structuredContent?: { ok?: boolean; message?: string };
        isError?: boolean;
      };
      const healthMs = Date.now() - healthStarted;

      // The health-check resolved FIRST, while the query was still in flight…
      expect(order).toEqual(["health"]);
      // …and it answered fast (liveness path), not after the sidecar sleep.
      expect(healthMs).toBeLessThan((QUERY_SLEEP_S - 1) * 1000);
      expect(health.isError).toBeFalsy();
      expect(health.structuredContent?.ok).toBe(true);
      expect(health.structuredContent?.message).toMatch(/in flight/i);

      // 3. The slow query then completes normally with its own result.
      const query = (await slowQuery) as {
        structuredContent?: { count?: number; photos?: { uuid: string }[] };
        isError?: boolean;
      };
      expect(order).toEqual(["health", "query"]);
      expect(query.isError).toBeFalsy();
      expect(query.structuredContent?.count).toBe(1);
      expect(query.structuredContent?.photos?.[0]?.uuid).toBe("FAKE-SLOW-UUID");
    },
    (QUERY_SLEEP_S + 30) * 1000
  );

  it("health-check takes the full (non-liveness) path once the gate is idle again", async () => {
    // No sidecar operation in flight now — health-check must NOT answer from
    // the liveness fast path. The full path first probes `import osxphotos`
    // with the system python, which may or may not have it installed in this
    // synthetic environment — either full outcome is fine; what matters is
    // that the in-flight fast path is not taken when the gate is idle.
    const health = (await client.callTool({ name: "health-check", arguments: {} })) as {
      structuredContent?: { ok?: boolean; message?: string };
      isError?: boolean;
    };
    expect(health.isError).toBeFalsy();
    const message = health.structuredContent?.message ?? "";
    expect(message).not.toMatch(/in flight/i);
    // Full path evidence: either the fake sidecar's health payload (osxphotos
    // importable) or the dependency probe's setup hint (not importable).
    expect(message).toMatch(/0\.0-fake|osxphotos not installed/);
  }, 30_000);
});
