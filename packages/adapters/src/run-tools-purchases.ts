import { executePurchaseTool } from "./purchase-service.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";

async function purchaseTool(ctx: RunContext, call: ToolCall) {
  const { deps, run, bot, context } = ctx;
  return call.finish(
    await executePurchaseTool(
      deps,
      // The effect key is stable across replays, so a retried request reuses its purchase.
      { ...context, operationId: call.effectKey, botId: bot.id },
      run,
      call.name,
      call.args,
    ),
  );
}

/** Purchases from the user's connected wallet. */
export const purchaseTools: ToolHandlers = {
  request_purchase: purchaseTool,
  purchase_status: purchaseTool,
};
