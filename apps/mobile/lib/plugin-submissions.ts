import type {
  PluginSubmission,
  PluginSubmissionReview,
  PluginSubmissionStatus,
} from "@rakazo/contracts";
import { rpc } from "./api";
import { accountRpcQuery, queryClient } from "./query";

// The API's limit for a rejection reason.
const MAX_REASON = 1000;

export function pluginSubmissionsQuery(status: PluginSubmissionStatus) {
  return accountRpcQuery("marketplace/submissions", { status });
}

/** A rejection needs a reason; blank input is no answer. */
export function rejectionReason(value: string | undefined): string | null {
  return value?.trim().slice(0, MAX_REASON) || null;
}

/** Records the decision, then reloads every submissions list since the item changed status. */
export async function reviewPluginSubmission(
  review: PluginSubmissionReview,
): Promise<PluginSubmission> {
  const reviewed = await rpc("marketplace/review", review);
  await queryClient.invalidateQueries({
    predicate: (query) => query.queryKey.includes("marketplace/submissions"),
  });
  return reviewed;
}
