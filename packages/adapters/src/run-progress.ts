import type { MessageBlock } from "@rakazo/contracts";
import {
  appendTextSegment,
  appendToolCallSegment,
  createStreamingRedactor,
  endsSentence,
  isBackgroundRunTrigger,
  redactSecrets,
} from "@rakazo/core";
import type { Run } from "@rakazo/db";
import type { ExecutorDeps } from "./executor-deps.js";
import type { ReplyState, RunContext } from "./run-context.js";
import { publishMessage } from "./run-messages.js";
import { runPromotesMidTurnNarration } from "./run-replies.js";
import { isExactNoResponse } from "./silent-reply.js";
import {
  clampUserProgressMessage,
  dropTrailingText,
  extractNarrationText,
  isUserProgressClientNonce,
  isWorkingNote,
  midTurnProgressBudgetAllows,
  narrationStatusLine,
  USER_PROGRESS_MESSAGE_MAX_LENGTH,
  userProgressClientNonce,
} from "./user-progress.js";

/** A fresh reply that knows the progress messages earlier attempts of this run posted. */
export async function createReplyState(
  deps: ExecutorDeps,
  run: Run,
  secrets: string[],
): Promise<ReplyState> {
  const reply: ReplyState = {
    assembled: "",
    currentTextSegment: "",
    messageSegments: [],
    publishedTerminalSubagent: false,
    publishedMidTurnUserMessage: false,
    discardedMidTurnNarration: false,
    lastDiscardedMidTurnNarration: "",
    explicitNoResponse: false,
    assistantTurnText: "",
    midTurnUserTexts: [],
    midTurnProgressCount: 0,
    turnStartedAtMs: run.startedAt?.getTime() ?? Date.now(),
    progressBudgetStart: 0,
    steeringReplyPending: false,
    steeringResets: 0,
    lastSteeringResetAt: Number.NEGATIVE_INFINITY,
    workingNotes: [],
    textSinceLastStep: "",
    narrationStatusShowing: false,
    keptReplyLength: 0,
    pendingToolNames: [],
    pendingProgress: "",
    lastProgressAt: 0,
    hasStreamedText: false,
    assistantTurnBreakPending: false,
    redactor: createStreamingRedactor(secrets),
  };
  const priorProgress = await deps.prisma.message.findMany({
    where: { runId: run.id, role: "bot" },
    orderBy: { seq: "asc" },
    select: { blocks: true, clientNonce: true },
  });
  for (const message of priorProgress) {
    if (!isUserProgressClientNonce(message.clientNonce)) continue;
    const blocks = Array.isArray(message.blocks) ? (message.blocks as MessageBlock[]) : [];
    const text = blocks
      .filter((block): block is Extract<MessageBlock, { kind: "text" }> => block.kind === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    if (!text) continue;
    reply.midTurnUserTexts.push(text);
    reply.publishedMidTurnUserMessage = true;
    reply.midTurnProgressCount += 1;
  }
  return reply;
}

export function recordExplicitNoResponse(reply: ReplyState, text: string) {
  reply.explicitNoResponse ||= isExactNoResponse(text) || /\bNO_RESPONSE\b/.test(text);
}

/** Durable interim messages only on genuinely long turns, capped per run. */
export function canPublishDurableProgress(reply: ReplyState) {
  return (
    reply.steeringReplyPending ||
    midTurnProgressBudgetAllows(
      reply.midTurnProgressCount - reply.progressBudgetStart,
      Date.now() - reply.turnStartedAtMs,
    )
  );
}

/** The next interim message's nonce; it uses up the allowance for answering the person. */
export function nextProgressNonce(ctx: RunContext) {
  const { reply } = ctx.state;
  reply.steeringReplyPending = false;
  return userProgressClientNonce(ctx.run.id, reply.midTurnProgressCount++);
}

export function canPublishDurableNarration(ctx: RunContext) {
  return runPromotesMidTurnNarration(ctx.run.trigger) && canPublishDurableProgress(ctx.state.reply);
}

export function flushPendingTools(reply: ReplyState) {
  if (reply.currentTextSegment) {
    reply.messageSegments = appendTextSegment(reply.messageSegments, reply.currentTextSegment);
    reply.currentTextSegment = "";
  }
  for (const name of reply.pendingToolNames) {
    reply.messageSegments = appendToolCallSegment(reply.messageSegments, name);
  }
  reply.pendingToolNames = [];
}

export function tryFlushPendingTools(reply: ReplyState) {
  if (reply.pendingToolNames.length > 0 && endsSentence(reply.currentTextSegment))
    flushPendingTools(reply);
}

export async function flushProgress(ctx: RunContext) {
  const { deps, run, runId, bot, thread } = ctx;
  const { reply } = ctx.state;
  // Routines may finish silently. Do not leak narration or a partial silence
  // sentinel before the final outcome is known.
  if (
    ctx.scripted ||
    !reply.pendingProgress ||
    run.trigger === "routine" ||
    isBackgroundRunTrigger(run.trigger)
  )
    return;
  await deps.events.append({
    spaceId: run.spaceId,
    threadId: thread.id,
    botId: bot.id,
    type: "thread.progress",
    runId,
    // The first flush replaces the "working…" placeholder outright — a delta here
    // would otherwise get appended straight onto it with no separator.
    payload: reply.hasStreamedText
      ? { delta: reply.pendingProgress, streaming: true }
      : { text: reply.pendingProgress, streaming: true },
  });
  reply.hasStreamedText = true;
  reply.pendingProgress = "";
  reply.lastProgressAt = Date.now();
}

/**
 * Text that may not become a message yet: a short note becomes the working line instead of
 * piling into the reply; anything longer, or with a link or code, may be part of the answer
 * and stays in the reply. Returns the note so the caller can show it.
 */
export async function publishMidTurnNarration(ctx: RunContext, beforeConnectCard = false) {
  const { deps, run } = ctx;
  const { reply } = ctx.state;
  const extracted = extractNarrationText(reply.messageSegments, reply.currentTextSegment);
  const redacted = redactSecrets(extracted.text, ctx.secrets).trim();
  const narration = clampUserProgressMessage(redacted);
  const canPublish =
    canPublishDurableNarration(ctx) ||
    (beforeConnectCard && runPromotesMidTurnNarration(run.trigger));
  // Text that may be part of the answer stays in the reply whole: anything kept there
  // earlier, text a message can't hold without cutting it, and, when no message may be
  // posted, anything that isn't a short note. Only what follows kept text moves on.
  if (
    narration &&
    !ctx.allowSilentEmptyRun &&
    runPromotesMidTurnNarration(run.trigger) &&
    (reply.keptReplyLength > 0 ||
      (canPublish ? redacted.length > USER_PROGRESS_MESSAGE_MAX_LENGTH : !isWorkingNote(narration)))
  ) {
    const rawTail = extracted.text.slice(reply.keptReplyLength);
    const tail = redactSecrets(rawTail, ctx.secrets).trim();
    if (reply.keptReplyLength > 0 && !tail) return undefined;
    // Joined to the kept text without the turn break, a tail that no longer redacts the
    // same may hold the rest of a secret split across a step, so it stays with that text.
    const joined = redactSecrets(
      extracted.text.slice(0, reply.keptReplyLength) + rawTail.trimStart(),
      ctx.secrets,
    ).trim();
    const movable =
      reply.keptReplyLength > 0 &&
      joined.endsWith(tail) &&
      (canPublish ? tail.length <= USER_PROGRESS_MESSAGE_MAX_LENGTH : isWorkingNote(tail));
    if (!movable) {
      reply.keptReplyLength = extracted.text.length;
      // Notes before it are followed by text that stays.
      reply.workingNotes.length = 0;
      return undefined;
    }
    ({ segments: reply.messageSegments, currentText: reply.currentTextSegment } = dropTrailingText(
      reply.messageSegments,
      reply.currentTextSegment,
      rawTail.length,
    ));
    reply.assembled = extractNarrationText(reply.messageSegments, reply.currentTextSegment).text;
    reply.hasStreamedText = false;
    reply.pendingProgress = "";
    reply.redactor.skip();
    if (!canPublish) {
      reply.discardedMidTurnNarration = true;
      reply.lastDiscardedMidTurnNarration = tail;
      reply.workingNotes.push(tail);
      return tail;
    }
    reply.workingNotes.length = 0;
    await publishMessage(
      deps,
      run,
      "bot",
      [{ kind: "text", text: tail }],
      undefined,
      nextProgressNonce(ctx),
    );
    reply.midTurnUserTexts.push(tail);
    reply.publishedMidTurnUserMessage = true;
    reply.narrationStatusShowing = false;
    return undefined;
  }
  reply.messageSegments = extracted.remaining;
  reply.currentTextSegment = "";
  reply.keptReplyLength = 0;
  if (!narration) return undefined;
  reply.hasStreamedText = false;
  reply.pendingProgress = "";
  // Text the redactor still holds back belongs to the note just taken out.
  reply.redactor.skip();
  if (!canPublish) {
    reply.assembled = "";
    reply.discardedMidTurnNarration = true;
    reply.lastDiscardedMidTurnNarration = narration;
    if (runPromotesMidTurnNarration(run.trigger) && !ctx.allowSilentEmptyRun) {
      reply.workingNotes.push(narration);
    }
    return narration;
  }
  reply.assembled = "";
  reply.workingNotes.length = 0;
  await publishMessage(
    deps,
    run,
    "bot",
    [{ kind: "text", text: narration }],
    undefined,
    nextProgressNonce(ctx),
  );
  reply.midTurnUserTexts.push(narration);
  reply.publishedMidTurnUserMessage = true;
  reply.narrationStatusShowing = false;
  return undefined;
}

/**
 * Replaces the text streamed so far with the note as the working line. Runs that hold their
 * narration back (routines, peers, background work) keep their live view.
 */
export async function showNarrationStatus(ctx: RunContext, note: string | undefined) {
  const { deps, run, runId, bot, thread } = ctx;
  if (
    !note ||
    ctx.scripted ||
    !runPromotesMidTurnNarration(run.trigger) ||
    isBackgroundRunTrigger(run.trigger)
  )
    return;
  ctx.state.reply.narrationStatusShowing = true;
  await deps.events.append({
    spaceId: run.spaceId,
    threadId: thread.id,
    botId: bot.id,
    type: "thread.progress",
    runId,
    payload: { reset: true, text: narrationStatusLine(note), activity: true },
  });
}
