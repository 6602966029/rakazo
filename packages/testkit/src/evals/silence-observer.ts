import { InMemoryRealtimeFanout } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";

/** Capture progress at publication: finalization deletes these transient database rows. */
export class SilenceObserver extends InMemoryRealtimeFanout {
  readonly events: Array<{ runId: string | null; type: string; payload: unknown }> = [];
  failed = false;
  private prisma?: PrismaClient;

  attach(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  override async publish(topic: string, payload: string): Promise<void> {
    if (this.prisma && topic.startsWith("thread:")) {
      try {
        const { cursor } = JSON.parse(payload) as { cursor: number };
        const event = await this.prisma.event.findFirst({
          where: { threadId: topic.slice("thread:".length), seq: cursor },
          select: { runId: true, type: true, payload: true },
        });
        if (event) this.events.push(event);
      } catch {
        this.failed = true;
      }
    }
    await super.publish(topic, payload);
  }
}
