import type { BackgroundJobExecution } from "@rakazo/adapter-kit";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";

function admissionMemory(activeRuns: number) {
  // One incoming run needs room for an attachment and its decoding/copying.
  // Resident allocations are already reflected in available physical memory.
  const reserve = ATTACHMENT_MAX_BYTES * 4;
  const available = process.availableMemory();
  return {
    pressure: available <= reserve,
    fields: {
      "worker.active_runs": activeRuns,
      "memory.available_bytes": available,
      "memory.reserve_bytes": reserve,
    },
  };
}

/** Tracks agent lifetimes separately from short wakeup deliveries. */
export class RunExecutionHost {
  private stopping = false;
  private pressureStartedAt: number | undefined;
  private readonly activeRuns = new Set<Promise<void>>();
  private readonly capacityWaiters = new Set<() => void>();

  start(): void {
    this.stopping = false;
    this.pressureStartedAt = undefined;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.pressureStartedAt = undefined;
    for (const notify of this.capacityWaiters) notify();
    await Promise.allSettled(this.activeRuns);
  }

  /** Returns false before invoking the callback when nonwaiting admission has no capacity. */
  async execute(
    execute: (execution: BackgroundJobExecution) => Promise<void>,
    options: { waitForCapacity?: boolean } = {},
  ): Promise<boolean> {
    // A waiting network request consumes no dispatch capacity. Admit independent
    // runs while the process has memory headroom, rather than limiting their count.
    // Under real pressure, wait for a resident run to finish before loading more
    // histories. With no resident runs, allow work to resume instead of deadlocking
    // behind memory that has not been reclaimed yet.
    while (this.activeRuns.size > 0) {
      if (this.stopping) throw new Error("Worker is stopping");
      const memory = admissionMemory(this.activeRuns.size);
      if (!memory.pressure) break;
      if (this.pressureStartedAt === undefined) {
        this.pressureStartedAt = Date.now();
        getLogger().info("run.admission_wait", {
          "admission.reason": "physical",
          ...memory.fields,
        });
      }
      if (options.waitForCapacity === false) return false;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          this.capacityWaiters.delete(finish);
          resolve();
        };
        const timer = setTimeout(finish, 1_000);
        timer.unref?.();
        this.capacityWaiters.add(finish);
      });
    }
    if (this.stopping) throw new Error("Worker is stopping");
    if (this.pressureStartedAt !== undefined) {
      getLogger().info("run.admission_resumed", {
        "admission.reason": "physical",
        "run.admission_wait_ms": Math.max(0, Date.now() - this.pressureStartedAt),
        ...admissionMemory(this.activeRuns.size).fields,
      });
      this.pressureStartedAt = undefined;
    }
    let onRunStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      onRunStarted = resolve;
    });
    const executing = execute({ onRunStarted });
    const finish = () => {
      this.activeRuns.delete(tracked);
      for (const notify of this.capacityWaiters) notify();
    };
    // runCorrelatedJob reports failures in their original context. Observe the
    // rejection after handoff without reporting it again. Before handoff, the
    // original rejecting promise below still reaches Graphile's retry handling.
    const tracked = executing.then(finish, finish);
    this.activeRuns.add(tracked);
    await Promise.race([started, executing]);
    return true;
  }
}
