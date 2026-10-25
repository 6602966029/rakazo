import type { AdapterContext } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";

export function computerContext(actor: Actor, botId: string, operationId: string): AdapterContext {
  return {
    operationId,
    traceId: operationId,
    spaceId: actor.spaceId,
    userId: actor.userId,
    botId,
    signal: new AbortController().signal,
  };
}
