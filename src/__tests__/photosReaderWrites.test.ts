/**
 * Hermetic tests for photos_reader.py's WRITE command logic — the gate, target
 * validation, create-album idempotency, add/remove membership math, the
 * remove rebuild sequence, union keyword merges, and before/after echoes.
 *
 * The REAL sidecar script runs one-shot under python3 with PYTHONPATH pointing
 * at test/fixtures/pyfakes, whose fake photoscript/osxphotos/bitmath modules
 * shadow the real ones (PYTHONPATH precedes site-packages) and log every
 * mutation — so the actual handler code is exercised end-to-end with no
 * Photos.app, no AppleScript, and no macOS permissions. Self-skips when no
 * python3 is available (any >= 3.9 works; the fakes are stdlib-only).
 */
import { describe, expect, it, beforeAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const READER = resolve(__dirname, "../utils/photos_reader.py");
const PYFAKES = resolve(__dirname, "../../test/fixtures/pyfakes");
const VENV_PYTHON = resolve(__dirname, "../../venv/bin/python3");

function pickPython(): string | null {
  if (existsSync(VENV_PYTHON)) return VENV_PYTHON;
  try {
    execFileSync("python3", ["--version"], { stdio: "pipe" });
    return "python3";
  } catch {
    return null;
  }
}

let python: string | null = null;
beforeAll(() => {
  python = pickPython();
});

interface FakeState {
  albums: Array<{
    uuid: string;
    name: string;
    path?: string;
    members: string[];
    folder?: string[];
  }>;
  photos: Record<
    string,
    { title?: string; description?: string; favorite?: boolean; keywords?: string[] }
  >;
}

const baseState = (): FakeState => ({
  albums: [{ uuid: "A11111", name: "Trailcam", path: "Trailcam", members: ["0001", "0002"] }],
  photos: {
    "0001": { title: "one", description: "", favorite: false, keywords: ["Reveal", "deer"] },
    "0002": { title: "", description: "", favorite: true, keywords: [] },
    "0003": { title: "", description: "", favorite: false, keywords: [] },
  },
});

interface RunResult {
  status: number;
  json: Record<string, unknown>;
  log: Array<Record<string, unknown>>;
}

function runReader(
  args: string[],
  state: FakeState = baseState(),
  opts: { writesEnabled?: boolean } = {}
): RunResult {
  const dir = mkdtempSync(join(tmpdir(), "photos-writes-test-"));
  const statePath = join(dir, "state.json");
  const logPath = join(dir, "log.jsonl");
  writeFileSync(statePath, JSON.stringify(state));
  writeFileSync(logPath, "");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONPATH: PYFAKES,
    FAKE_PHOTOSCRIPT_STATE: statePath,
    FAKE_PHOTOSCRIPT_LOG: logPath,
  };
  delete env.APPLE_PHOTOS_MCP_ENABLE_WRITES;
  if (opts.writesEnabled !== false) {
    env.APPLE_PHOTOS_MCP_ENABLE_WRITES = "1";
  }

  const proc = spawnSync(python as string, [READER, ...args], {
    env,
    encoding: "utf-8",
    timeout: 30_000,
  });
  const stdout = (proc.stdout ?? "").trim();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Error(
      `photos_reader did not print JSON (status ${proc.status}):\nstdout: ${stdout}\nstderr: ${proc.stderr}`
    );
  }
  const log = readFileSync(logPath, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { status: proc.status ?? -1, json, log };
}

describe("photos_reader write commands (hermetic, fake photoscript)", () => {
  describe("the gate (defense in depth inside the sidecar)", () => {
    it("refuses every write command when APPLE_PHOTOS_MCP_ENABLE_WRITES is unset", (ctx) => {
      if (!python) ctx.skip();
      for (const args of [
        ["create-album", "--name=X"],
        ["add-to-album", "--album=Trailcam", "--uuid=0001"],
        ["remove-from-album", "--album=Trailcam", "--uuid=0001"],
        ["set-photo-metadata", "--uuid=0001", "--title=t"],
        ["set-keywords", "--uuid=0001", "--add=k"],
      ]) {
        const r = runReader(args, baseState(), { writesEnabled: false });
        expect(r.status).toBe(1);
        expect(String(r.json.error)).toMatch(/read-only by default/);
        expect(String(r.json.error)).toContain("APPLE_PHOTOS_MCP_ENABLE_WRITES");
        expect(r.log).toEqual([]); // nothing was mutated — nothing even ran
      }
    });

    it("disables photoscript's killall-Photos retry policy before any write", (ctx) => {
      if (!python) ctx.skip();
      const r = runReader(["create-album", "--name=Fresh"]);
      expect(r.status).toBe(0);
      expect(r.log[0]).toMatchObject({ op: "configure_run_script", retry_enabled: false });
    });
  });

  describe("create-album", () => {
    it("creates a new top-level album (created=true)", (ctx) => {
      if (!python) ctx.skip();
      const r = runReader(["create-album", "--name=Fresh"]);
      expect(r.status).toBe(0);
      expect(r.json.created).toBe(true);
      const album = r.json.album as Record<string, unknown>;
      expect(album.name).toBe("Fresh");
      expect(r.log.some((e) => e.op === "create_album")).toBe(true);
    });

    it("is idempotent: an existing name is returned with created=false and nothing is created", (ctx) => {
      if (!python) ctx.skip();
      const r = runReader(["create-album", "--name=Trailcam"]);
      expect(r.status).toBe(0);
      expect(r.json.created).toBe(false);
      expect((r.json.album as Record<string, unknown>).uuid).toBe("A11111");
      expect(r.log.filter((e) => e.op === "create_album")).toEqual([]);
    });

    it("creates the folder path as needed and nests the album", (ctx) => {
      if (!python) ctx.skip();
      const r = runReader(["create-album", "--name=Camping", "--folder=Trips/2026"]);
      expect(r.status).toBe(0);
      expect(r.json.created).toBe(true);
      expect((r.json.album as Record<string, unknown>).path).toBe("Trips/2026/Camping");
      expect(r.log.some((e) => e.op === "make_folders")).toBe(true);
      const mk = r.log.find((e) => e.op === "make_folders") as { path: string[] };
      expect(mk.path).toEqual(["Trips", "2026"]);
    });
  });

  describe("add-to-album", () => {
    it("splits the batch into added / alreadyPresent / notFound", (ctx) => {
      if (!python) ctx.skip();
      const r = runReader([
        "add-to-album",
        "--album=Trailcam",
        "--uuid=0002",
        "--uuid=0003",
        "--uuid=DEAD1",
      ]);
      expect(r.status).toBe(0);
      expect(r.json.addedCount).toBe(1);
      expect(r.json.added).toEqual(["0003"]);
      expect(r.json.alreadyPresent).toEqual(["0002"]);
      expect(r.json.notFound).toEqual(["DEAD1"]);
      const add = r.log.find((e) => e.op === "album_add") as { ids: string[] };
      expect(add.ids).toEqual(["0003"]); // only the missing one was sent to Photos
    });

    it("fails clearly when the album does not exist (validate-first)", (ctx) => {
      if (!python) ctx.skip();
      const r = runReader(["add-to-album", "--album=Nope", "--uuid=0001"]);
      expect(r.status).toBe(1);
      expect(String(r.json.error)).toMatch(/Album not found: 'Nope'/);
      expect(r.log.filter((e) => e.op === "album_add")).toEqual([]);
    });

    it("fails when NO requested photo exists", (ctx) => {
      if (!python) ctx.skip();
      const r = runReader(["add-to-album", "--album=Trailcam", "--uuid=DEAD1", "--uuid=DEAD2"]);
      expect(r.status).toBe(1);
      expect(String(r.json.error)).toMatch(/None of the requested photos exist/);
    });

    it("resolves the album by UUID as well as by name", (ctx) => {
      if (!python) ctx.skip();
      const r = runReader(["add-to-album", "--album=A11111", "--uuid=0003"]);
      expect(r.status).toBe(0);
      expect((r.json.album as Record<string, unknown>).uuid).toBe("A11111");
    });
  });

  describe("remove-from-album", () => {
    it("removes members by REBUILDING the album (create temp → add keepers → delete old → rename)", (ctx) => {
      if (!python) ctx.skip();
      const r = runReader(["remove-from-album", "--album=Trailcam", "--uuid=0001"]);
      expect(r.status).toBe(0);
      expect(r.json.removedCount).toBe(1);
      expect(r.json.removed).toEqual(["0001"]);
      expect(r.json.albumRecreated).toBe(true);
      expect(r.json.previousAlbumUuid).toBe("A11111");
      const album = r.json.album as Record<string, unknown>;
      expect(album.uuid).not.toBe("A11111"); // the rebuild changes the UUID
      expect(album.name).toBe("Trailcam");

      const ops = r.log.map((e) => e.op);
      const seq = ops.filter((o) =>
        ["create_album", "album_add", "delete_album", "rename_album"].includes(o as string)
      );
      expect(seq).toEqual(["create_album", "album_add", "delete_album", "rename_album"]);
      const add = r.log.find((e) => e.op === "album_add") as { ids: string[] };
      expect(add.ids).toEqual(["0002"]); // only the kept photo moved to the new album
      const del = r.log.find((e) => e.op === "delete_album") as { uuid: string };
      expect(del.uuid).toBe("A11111"); // the ORIGINAL album was deleted, never a photo
    });

    it("is a no-op (no rebuild, no deletion) when none of the UUIDs are members", (ctx) => {
      if (!python) ctx.skip();
      const r = runReader(["remove-from-album", "--album=Trailcam", "--uuid=0003"]);
      expect(r.status).toBe(0);
      expect(r.json.removedCount).toBe(0);
      expect(r.json.albumRecreated).toBe(false);
      expect(r.json.notInAlbum).toEqual(["0003"]);
      expect((r.json.album as Record<string, unknown>).uuid).toBe("A11111"); // unchanged
      expect(r.log.filter((e) => e.op === "delete_album")).toEqual([]);
      expect(r.log.filter((e) => e.op === "create_album")).toEqual([]);
    });
  });

  describe("set-photo-metadata", () => {
    it("writes only the fields given and echoes before/after", (ctx) => {
      if (!python) ctx.skip();
      const r = runReader([
        "set-photo-metadata",
        "--uuid=0002",
        "--title=Best shot",
        "--favorite=false",
      ]);
      expect(r.status).toBe(0);
      expect(r.json.updated).toEqual(["title", "favorite"]);
      expect(r.json.before).toMatchObject({ title: "", favorite: true });
      expect(r.json.after).toMatchObject({ title: "Best shot", favorite: false });
      // description was not passed → not written
      expect(r.log.filter((e) => e.op === "set_description")).toEqual([]);
    });

    it("fails clearly for an unknown photo (validate-first)", (ctx) => {
      if (!python) ctx.skip();
      const r = runReader(["set-photo-metadata", "--uuid=DEAD1", "--title=x"]);
      expect(r.status).toBe(1);
      expect(String(r.json.error)).toBe("Photo not found: DEAD1");
      expect(r.log.filter((e) => String(e.op).startsWith("set_"))).toEqual([]);
    });

    it("rejects a call with nothing to update", (ctx) => {
      if (!python) ctx.skip();
      const r = runReader(["set-photo-metadata", "--uuid=0001"]);
      expect(r.status).toBe(1);
      expect(String(r.json.error)).toMatch(/Nothing to update/);
    });
  });

  describe("set-keywords (union semantics)", () => {
    it("merges add/remove into the CURRENT list — unmentioned keywords survive", (ctx) => {
      if (!python) ctx.skip();
      const r = runReader([
        "set-keywords",
        "--uuid=0001",
        "--add=Trailcam",
        "--add=deer", // already present → no-op
        "--remove=Reveal",
      ]);
      expect(r.status).toBe(0);
      expect(r.json.before).toEqual(["Reveal", "deer"]);
      expect(r.json.after).toEqual(["deer", "Trailcam"]); // deer preserved, never blanked
      expect(r.json.added).toEqual(["Trailcam"]);
      expect(r.json.removed).toEqual(["Reveal"]);
      expect(r.json.changed).toBe(true);
      const set = r.log.find((e) => e.op === "set_keywords") as { value: string[] };
      expect(set.value).toEqual(["deer", "Trailcam"]);
    });

    it("skips the write entirely when the merge changes nothing", (ctx) => {
      if (!python) ctx.skip();
      const r = runReader(["set-keywords", "--uuid=0001", "--add=deer", "--remove=absent"]);
      expect(r.status).toBe(0);
      expect(r.json.changed).toBe(false);
      expect(r.json.after).toEqual(["Reveal", "deer"]);
      expect(r.log.filter((e) => e.op === "set_keywords")).toEqual([]);
    });

    it("rejects a keyword passed in both add and remove", (ctx) => {
      if (!python) ctx.skip();
      const r = runReader(["set-keywords", "--uuid=0001", "--add=deer", "--remove=deer"]);
      expect(r.status).toBe(1);
      expect(String(r.json.error)).toMatch(/both added and removed: deer/);
    });

    it("rejects a call with neither add nor remove", (ctx) => {
      if (!python) ctx.skip();
      const r = runReader(["set-keywords", "--uuid=0001"]);
      expect(r.status).toBe(1);
      expect(String(r.json.error)).toMatch(/Nothing to do/);
    });
  });
});
