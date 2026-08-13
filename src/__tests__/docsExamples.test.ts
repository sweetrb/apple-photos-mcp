/**
 * Guard A — every documented example is real.
 *
 * Two doc-vs-reality checks that run in the UNIT suite (vitest.config.ts, the
 * config behind the required `test (22)` / `test (24)` contexts), because a
 * guard that only runs in an opt-in suite is not a guard:
 *
 *   (a) Every fenced ```json block in README.md / CLAUDE.md / docs/*.md parses
 *       as JSON. A malformed JSON example in setup docs actively breaks the
 *       user who copies it.
 *   (b) Every APPLE_<APP>_MCP_* environment variable named in those docs still
 *       exists somewhere under src/. Catches a doc that advertises a renamed or
 *       deleted knob.
 *
 * Both checks assert their input set is NON-EMPTY, so deleting the inputs (or
 * retagging every fence away from `json`) fails loudly instead of passing
 * vacuously on an empty set.
 *
 * Fences that are deliberately PARTIAL (a fragment, an excerpt of one key) must
 * be retagged ```jsonc or ```text so they are honestly not-JSON — they must not
 * be allowlisted here, which would make this guard decorative.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** README.md, CLAUDE.md and every docs/*.md — the user-facing doc surface. */
function docFiles(): string[] {
  const docsDir = join(REPO_ROOT, "docs");
  return [
    join(REPO_ROOT, "README.md"),
    join(REPO_ROOT, "CLAUDE.md"),
    ...readdirSync(docsDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => join(docsDir, f)),
  ];
}

/** Every file under src/, recursively. */
function srcFiles(dir = join(REPO_ROOT, "src")): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...srcFiles(p));
    else out.push(p);
  }
  return out;
}

interface Fence {
  file: string;
  /** 1-based line number of the opening fence. */
  line: number;
  /** Lowercased first word of the info string (e.g. "json", "bash", ""). */
  lang: string;
  body: string;
}

/**
 * CommonMark-ish fenced-code-block scanner: a fence opens with >=3 backticks
 * (optionally indented) plus an info string, and closes with at least as many
 * backticks and no info string. Handles the indented fences these docs use
 * inside numbered lists.
 */
function fences(file: string): Fence[] {
  const lines = readFileSync(file, "utf8").split("\n");
  const out: Fence[] = [];
  let open: { ticks: number; lang: string; line: number; body: string[] } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(`{3,})(.*)$/.exec(lines[i]);
    if (open === null) {
      if (m) {
        open = {
          ticks: m[1].length,
          lang: m[2].trim().split(/\s+/)[0].toLowerCase(),
          line: i + 1,
          body: [],
        };
      }
      continue;
    }
    if (m && m[1].length >= open.ticks && m[2].trim() === "") {
      out.push({
        file: relative(REPO_ROOT, file),
        line: open.line,
        lang: open.lang,
        body: open.body.join("\n"),
      });
      open = null;
      continue;
    }
    open.body.push(lines[i]);
  }
  return out;
}

/**
 * An env-var token as written in the docs. Deliberately greedy on the trailing
 * `[A-Z0-9_]+` so a prose family name like `APPLE_MAIL_MCP_IMAP_` is captured
 * WITH its trailing underscore and can be recognised as a prefix rather than
 * mistaken for a real variable.
 */
const ENV_TOKEN = /APPLE_[A-Z0-9]+_MCP_[A-Z0-9_]+/g;

describe("Guard A(a) — every ```json example in the docs parses", () => {
  const jsonFences = docFiles()
    .flatMap(fences)
    .filter((f) => f.lang === "json");

  it("checks a non-empty set of json fences", () => {
    // Vacuity guard: if every fence were retagged away from `json` (or the docs
    // deleted), the per-fence assertions below would all pass on an empty set.
    expect(jsonFences.length).toBeGreaterThan(0);
  });

  it("parses every ```json fence", () => {
    const bad = jsonFences.flatMap((f) => {
      try {
        JSON.parse(f.body);
        return [];
      } catch (err) {
        return [`${f.file}:${f.line} — ${(err as Error).message}`];
      }
    });

    expect(
      bad,
      `Malformed ` +
        "```json" +
        ` block(s) in the docs. Either fix the JSON, or — if the block is a deliberate ` +
        `fragment/excerpt — retag the fence ` +
        "```jsonc" +
        ` or ` +
        "```text" +
        ` so it is honestly not-JSON:\n  ${bad.join("\n  ")}`
    ).toEqual([]);
  });
});

describe("Guard A(b) — every env var named in the docs exists in src/", () => {
  const srcBlob = srcFiles()
    .map((p) => readFileSync(p, "utf8"))
    .join("\n");
  const realVars = new Set(srcBlob.match(ENV_TOKEN) ?? []);

  const documented = new Map<string, Set<string>>();
  for (const file of docFiles()) {
    const rel = relative(REPO_ROOT, file);
    for (const token of readFileSync(file, "utf8").match(ENV_TOKEN) ?? []) {
      if (!documented.has(token)) documented.set(token, new Set());
      documented.get(token)!.add(rel);
    }
  }

  it("finds env vars in both the docs and src/", () => {
    // Vacuity guard on both sides: an empty doc set or an empty src set would
    // make the subset check below trivially true.
    expect(documented.size).toBeGreaterThan(0);
    expect(realVars.size).toBeGreaterThan(0);
  });

  it("has no documented env var that is absent from src/", () => {
    const missing = [...documented.entries()]
      .filter(([token]) => {
        // Exact match against a variable that really exists in src/.
        if (realVars.has(token)) return false;
        // A prose family name (e.g. `APPLE_PHOTOS_MCP_SIDECAR_`) is written as a
        // strict prefix of the real variables it groups. Accept it only when it
        // ends in `_` — otherwise a truncated or renamed knob would slip
        // through as a "prefix". Derived from the real vars, never hardcoded.
        if (token.endsWith("_") && [...realVars].some((real) => real.startsWith(token))) {
          return false;
        }
        // Named in the docs, absent from src/ — stale or typo'd.
        return true;
      })
      .map(([token, files]) => `${token} (documented in ${[...files].sort().join(", ")})`);

    expect(
      missing,
      `Doc(s) name environment variable(s) that do not appear anywhere under src/. ` +
        `Either the knob was renamed/removed and the docs are stale, or the doc has a typo:\n  ` +
        missing.join("\n  ")
    ).toEqual([]);
  });
});
