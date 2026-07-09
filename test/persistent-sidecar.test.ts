/**
 * Persistent-sidecar contract — the acceptance test for the serve-mode flip
 * (1.4.0). Boots the REAL built server (build/index.js) over stdio against a
 * synthetic SERVE-CAPABLE python sidecar and proves, end-to-end through the
 * MCP SDK:
 *
 *   1. amortization — consecutive tool calls are served by ONE resident
 *      python process (same pid, increasing request counter) instead of a
 *      spawn per call, and warm calls skip the simulated startup cost;
 *   2. export progress — serve-mode progress lines become MCP progress
 *      notifications when the request carries a progressToken;
 *   3. restart-on-crash — a sidecar that dies mid-request fails THAT request,
 *      and the next call transparently respawns a fresh process;
 *   4. idle timeout — APPLE_PHOTOS_MCP_SIDECAR_IDLE_MS kills the resident
 *      process between calls, and the next call respawns it.
 *
 * The synthetic sidecar implements the line-delimited JSON protocol (ready
 * handshake, id echo, result/error/progress lines) plus a scripted `crash`
 * behavior, and sleeps READY_DELAY_S before the handshake to simulate the
 * one-time PhotosDB parse. It needs only a stock python3 — no osxphotos, no
 * Photos library, no Full Disk Access — so this suite runs anywhere,
 * including CI. Requires build/ (CI runs the build before test:integration).
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

const REAL_BUILD = resolve(__dirname, "../build/index.js");

/** Simulated one-time startup cost (import + PhotosDB parse), in seconds. */
const READY_DELAY_S = 1.5;

const FAKE_SERVE_READER = `#!/usr/bin/env python3
"""Synthetic photos_reader implementing the --serve protocol."""
import json
import os
import sys
import time

def result(rid, data):
    print(json.dumps({"id": rid, "type": "result", "data": data}), flush=True)

def main():
    if sys.argv[1:2] != ["--serve"]:
        # One-shot fallback path (not exercised by this suite).
        print(json.dumps({"error": "fake reader supports only --serve"}))
        return 1
    time.sleep(${READY_DELAY_S})  # simulated import + full-library parse
    print(json.dumps({"type": "ready", "protocol": 1}), flush=True)
    served = 0
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        rid = req.get("id")
        cmd = req.get("command")
        args = req.get("args") or []
        served += 1
        if "--title=crash" in args:
            os._exit(9)  # scripted mid-request death
        if cmd == "query":
            result(rid, {
                "count": 1, "returned": 1,
                "photos": [{
                    "uuid": "FAKE-UUID",
                    "filename": "pid-%d-req-%d.jpg" % (os.getpid(), served),
                    "date": None, "title": None, "favorite": False,
                    "hidden": False, "isMissing": False, "isPhoto": True,
                    "isMovie": False, "width": 1, "height": 1,
                    "albums": [], "keywords": [], "persons": []
                }]
            })
        elif cmd == "export":
            total = sum(1 for a in args if a.startswith("--uuid="))
            for i in range(total):
                print(json.dumps({
                    "id": rid, "type": "progress",
                    "done": i, "total": total,
                    "current": "IMG_%04d.jpg" % i, "uuid": "U%d" % i,
                }), flush=True)
                # Each photo takes real time to export; without spacing, the
                # SDK *client* coalesces a single-burst notification train
                # (server-side ordering is covered by unit tests either way).
                time.sleep(0.1)
            print(json.dumps({
                "id": rid, "type": "progress", "done": total, "total": total,
            }), flush=True)
            result(rid, {
                "destination": "/tmp/fake-dest", "exportedCount": total,
                "skippedCount": 0,
                "exported": ["/tmp/fake-dest/IMG_%04d.jpg" % i for i in range(total)],
                "skipped": [],
            })
        else:
            print(json.dumps({
                "id": rid, "type": "error",
                "error": "unsupported command in fake serve sidecar: %s" % cmd,
            }), flush=True)
    return 0

if __name__ == "__main__":
    sys.exit(main())
`;

/** Build a temp project layout the bundled server resolves itself against. */
function makeLayout(): string {
  const layout = mkdtempSync(join(tmpdir(), "photos-mcp-persistent-"));
  mkdirSync(join(layout, "build"), { recursive: true });
  mkdirSync(join(layout, "src", "utils"), { recursive: true });
  copyFileSync(REAL_BUILD, join(layout, "build", "index.js"));
  writeFileSync(
    join(layout, "package.json"),
    JSON.stringify({ name: "apple-photos-mcp", version: "0.0.0-test", type: "module" })
  );
  writeFileSync(join(layout, "src", "utils", "photos_reader.py"), FAKE_SERVE_READER);
  return layout;
}

async function connect(layout: string, extraEnv: Record<string, string> = {}): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(layout, "build", "index.js")],
    env: {
      ...process.env,
      // No venv in the layout -> system python3; never auto-bootstrap.
      APPLE_PHOTOS_MCP_NO_AUTO_SETUP: "1",
      // Isolate from any real user config.
      APPLE_PHOTOS_MCP_CONFIG_FILE: join(layout, "no-such-config.json"),
      ...extraEnv,
    } as Record<string, string>,
  });
  const client = new Client({ name: "persistent-sidecar-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

/** Extract the fake sidecar's "pid-<pid>-req-<n>.jpg" witness from a query. */
function pidAndReq(res: unknown): { pid: number; req: number } {
  const photos = (res as { structuredContent?: { photos?: { filename?: string }[] } })
    .structuredContent?.photos;
  const m = /^pid-(\d+)-req-(\d+)\.jpg$/.exec(photos?.[0]?.filename ?? "");
  expect(m, `expected a pid-N-req-N.jpg filename, got ${photos?.[0]?.filename}`).not.toBeNull();
  return { pid: Number(m![1]), req: Number(m![2]) };
}

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const fn of cleanups) fn();
});

describe("persistent sidecar (real server over stdio, synthetic serve sidecar)", () => {
  it(
    "amortizes the startup cost: one resident process serves consecutive calls",
    async () => {
      const layout = makeLayout();
      const client = await connect(layout);
      cleanups.push(() => {
        void client.close();
        rmSync(layout, { recursive: true, force: true });
      });

      // Call 1 — cold: pays the simulated parse (READY_DELAY_S) once.
      const t1 = Date.now();
      const r1 = await client.callTool({ name: "query", arguments: {} });
      const cold = Date.now() - t1;
      const w1 = pidAndReq(r1);
      expect(cold).toBeGreaterThanOrEqual(READY_DELAY_S * 1000 - 50);

      // Calls 2 and 3 — warm: same process, no re-parse, dramatically faster.
      const t2 = Date.now();
      const r2 = await client.callTool({ name: "query", arguments: {} });
      const warm2 = Date.now() - t2;
      const t3 = Date.now();
      const r3 = await client.callTool({ name: "query", arguments: {} });
      const warm3 = Date.now() - t3;
      const w2 = pidAndReq(r2);
      const w3 = pidAndReq(r3);

      expect(w2.pid).toBe(w1.pid);
      expect(w3.pid).toBe(w1.pid);
      expect(w2.req).toBe(w1.req + 1);
      expect(w3.req).toBe(w1.req + 2);
      // Generous CI margin — the point is "no READY_DELAY_S re-pay".
      expect(warm2).toBeLessThan(1000);
      expect(warm3).toBeLessThan(1000);

      // The doctor reports persistent mode with the serving pid.
      const doctor = (await client.callTool({ name: "doctor", arguments: {} })) as {
        structuredContent?: { checks?: { name: string; status: string; detail: string }[] };
      };
      const mode = doctor.structuredContent?.checks?.find((c) => c.name === "sidecar_mode");
      expect(mode?.status).toBe("ok");
      expect(mode?.detail).toContain("persistent");
      expect(mode?.detail).toContain(String(w1.pid));
    },
    60_000
  );

  it(
    "forwards serve-mode export progress as MCP progress notifications",
    async () => {
      const layout = makeLayout();
      const client = await connect(layout);
      cleanups.push(() => {
        void client.close();
        rmSync(layout, { recursive: true, force: true });
      });

      const progress: { progress: number; total?: number; message?: string }[] = [];
      const result = await client.callTool(
        {
          name: "export",
          arguments: { uuid: ["AAAA-1", "BBBB-2", "CCCC-3"], dest: "/tmp/photos-mcp-progress" },
        },
        CallToolResultSchema,
        {
          onprogress: (p) => progress.push(p),
        }
      );

      const structured = (
        result as { structuredContent?: { exportedCount?: number; skippedCount?: number } }
      ).structuredContent;
      expect(structured?.exportedCount).toBe(3);
      expect(structured?.skippedCount).toBe(0);

      // One notification per photo plus the final done=total line.
      expect(progress.length).toBe(4);
      expect(progress[0]).toMatchObject({ progress: 0, total: 3 });
      expect(progress[0].message).toContain("IMG_0000.jpg");
      expect(progress[0].message).toContain("(1/3)");
      expect(progress[2]).toMatchObject({ progress: 2, total: 3 });
      expect(progress[3]).toMatchObject({ progress: 3, total: 3 });
    },
    60_000
  );

  it(
    "fails the in-flight request when the sidecar crashes, then respawns for the next call",
    async () => {
      const layout = makeLayout();
      const client = await connect(layout);
      cleanups.push(() => {
        void client.close();
        rmSync(layout, { recursive: true, force: true });
      });

      const before = pidAndReq(await client.callTool({ name: "query", arguments: {} }));

      // Scripted mid-request death: the tool call must FAIL (isError), not hang.
      const crashed = (await client.callTool({
        name: "query",
        arguments: { title: "crash" },
      })) as { isError?: boolean; content: { type: string; text: string }[] };
      expect(crashed.isError).toBe(true);
      expect(crashed.content[0].text).toMatch(/exited unexpectedly/i);

      // Restart-on-crash: next call is served by a FRESH process.
      const after = pidAndReq(await client.callTool({ name: "query", arguments: {} }));
      expect(after.pid).not.toBe(before.pid);
      expect(after.req).toBe(1); // new process, first request
    },
    60_000
  );

  it(
    "kills an idle sidecar after APPLE_PHOTOS_MCP_SIDECAR_IDLE_MS and respawns on the next call",
    async () => {
      const layout = makeLayout();
      const client = await connect(layout, { APPLE_PHOTOS_MCP_SIDECAR_IDLE_MS: "400" });
      cleanups.push(() => {
        void client.close();
        rmSync(layout, { recursive: true, force: true });
      });

      const first = pidAndReq(await client.callTool({ name: "query", arguments: {} }));
      // Well past the idle window — the resident process should be gone.
      await new Promise((r) => setTimeout(r, 1200));
      const second = pidAndReq(await client.callTool({ name: "query", arguments: {} }));
      expect(second.pid).not.toBe(first.pid);
      expect(second.req).toBe(1);
    },
    60_000
  );
});
