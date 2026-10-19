import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { SilenceObserver } from "./silence-observer.js";

describe("routine progress observation", () => {
  it("retains a published event after finalization removes the database row", async () => {
    let row: { runId: string; type: string; payload: unknown } | null = {
      runId: "routine-run",
      type: "thread.progress",
      payload: { text: "NO_RES", streaming: true },
    };
    const findFirst = vi.fn(async () => row);
    const observer = new SilenceObserver();
    observer.attach({ event: { findFirst } } as unknown as PrismaClient);
    const subscriber = vi.fn();
    await observer.subscribe("thread:thread-1", subscriber);
    await observer.publish("thread:thread-1", JSON.stringify({ cursor: 7 }));
    row = null;
    expect(observer.events).toEqual([
      {
        runId: "routine-run",
        type: "thread.progress",
        payload: { text: "NO_RES", streaming: true },
      },
    ]);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { threadId: "thread-1", seq: 7 } }),
    );
    expect(subscriber).toHaveBeenCalledOnce();
    expect(observer.failed).toBe(false);
    await observer.close();
  });

  it("marks observation failure instead of manufacturing a quiet run", async () => {
    const observer = new SilenceObserver();
    observer.attach({
      event: {
        findFirst: async () => {
          throw new Error("database unavailable");
        },
      },
    } as unknown as PrismaClient);
    await observer.publish("thread:thread-1", JSON.stringify({ cursor: 7 }));
    expect(observer.failed).toBe(true);
    expect(observer.events).toEqual([]);
    await observer.close();
  });
});
