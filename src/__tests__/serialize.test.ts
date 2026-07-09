/**
 * Tests for the sidecar serial execution gate (ported from apple-mail-mcp).
 */

import { describe, it, expect } from "vitest";
import { createSerialGate } from "../utils/serialize.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("createSerialGate", () => {
  it("runs tasks strictly in enqueue order", async () => {
    const gate = createSerialGate(0);
    const order: number[] = [];

    await Promise.all([
      gate(() => {
        order.push(1);
      }),
      gate(() => {
        order.push(2);
      }),
      gate(() => {
        order.push(3);
      }),
    ]);

    expect(order).toEqual([1, 2, 3]);
  });

  it("the second task starts only after the first one resolves", async () => {
    const gate = createSerialGate(0);
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((r) => {
      releaseFirst = r;
    });

    const p1 = gate(async () => {
      events.push("first:start");
      await firstDone;
      events.push("first:end");
    });
    const p2 = gate(() => {
      events.push("second:start");
    });

    // Give the event loop plenty of turns: the second task must NOT have
    // started while the first is still pending.
    await tick(20);
    expect(events).toEqual(["first:start"]);

    releaseFirst();
    await Promise.all([p1, p2]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("never overlaps tasks, even async ones", async () => {
    const gate = createSerialGate(0);
    let active = 0;
    let maxConcurrent = 0;

    const work = async (delay: number) => {
      active++;
      maxConcurrent = Math.max(maxConcurrent, active);
      await tick(delay);
      active--;
    };

    await Promise.all([gate(() => work(10)), gate(() => work(5)), gate(() => work(1))]);

    expect(maxConcurrent).toBe(1);
  });

  it("resolves each call with its own task's result", async () => {
    const gate = createSerialGate(0);

    const [a, b] = await Promise.all([gate(() => "first"), gate(() => Promise.resolve(2))]);

    expect(a).toBe("first");
    expect(b).toBe(2);
  });

  it("a failing task rejects its own call but does not break serialization", async () => {
    const gate = createSerialGate(0);
    const order: string[] = [];

    const p1 = gate(() => {
      order.push("a");
      throw new Error("boom");
    });
    const p2 = gate(() => {
      order.push("b");
      return "ok";
    });

    await expect(p1).rejects.toThrow("boom");
    await expect(p2).resolves.toBe("ok");
    expect(order).toEqual(["a", "b"]);
  });

  it("tracks pending: rises while tasks run/queue, returns to 0 when drained", async () => {
    const gate = createSerialGate(0);
    expect(gate.pending).toBe(0);

    let release!: () => void;
    const blocked = new Promise<void>((r) => {
      release = r;
    });

    const p1 = gate(() => blocked);
    const p2 = gate(() => "quick");
    expect(gate.pending).toBe(2);

    release();
    await Promise.all([p1, p2]);
    await tick();
    expect(gate.pending).toBe(0);
  });

  it("pending drains even when tasks reject", async () => {
    const gate = createSerialGate(0);
    const p = gate(() => {
      throw new Error("boom");
    });
    expect(gate.pending).toBe(1);
    await expect(p).rejects.toThrow("boom");
    await tick();
    expect(gate.pending).toBe(0);
  });

  it("inserts a settle delay between tasks when configured", async () => {
    const gate = createSerialGate(30);
    const stamps: number[] = [];

    const start = Date.now();
    await gate(() => {
      stamps.push(Date.now() - start);
    });
    await gate(() => {
      stamps.push(Date.now() - start);
    });

    // Second task starts only after the ~30ms settle following the first.
    expect(stamps[1]).toBeGreaterThanOrEqual(25);
  });
});
