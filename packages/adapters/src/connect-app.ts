import type { AdapterContext, ManagedConnectorProvider } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { appConnectCard, matchAppCatalog, matchesAppConnection } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { appendEventInTransaction, createThreadMessageInTransaction } from "@rakazo/db";

/** Catalog data is the only source of card content; serialize dedupe with the message write. */
export async function connectApp(
  deps: { prisma: PrismaClient; events: ThreadEvents },
  providers: ManagedConnectorProvider[],
  context: AdapterContext,
  target: { id: string; spaceId: string; threadId: string; botId: string },
  app: unknown,
  effectId: string,
) {
  if (typeof app !== "string" || !app.trim() || app.length > 100) {
    return { error: "Provide an app name or slug of at most 100 characters." };
  }
  const catalog = (
    await Promise.all(
      providers.map(async (provider) => {
        try {
          const query = await provider.catalog(context, app.trim());
          // A provider's text search may not recognize a featured alias such as gcal.
          const entries = matchAppCatalog(query, app) ? query : await provider.catalog(context);
          return entries.filter((entry) => entry.connectorId === provider.describe().id);
        } catch {
          return [];
        }
      }),
    )
  ).flat();
  const entry = matchAppCatalog(catalog, app);
  if (!entry) return { error: "No such app is available in the connector catalog." };
  if (entry.connected)
    return {
      status: "connected",
      message: "This app is already connected and its tools are available.",
    };
  const block = appConnectCard(entry);
  const committed = await deps.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
    const messages = await tx.message.findMany({
      where: { threadId: target.threadId },
      select: { blocks: true, clientNonce: true },
    });
    const nonce = `connect-app:${effectId}`;
    if (
      messages.some(
        (message) =>
          message.clientNonce === nonce ||
          (message.blocks as MessageBlock[]).some(
            (candidate) =>
              matchesAppConnection(candidate, entry.connectorId, entry.slug) &&
              candidate.status === "pending",
          ),
      )
    )
      return null;
    const message = await createThreadMessageInTransaction(tx, {
      threadId: target.threadId,
      botId: target.botId,
      runId: target.id,
      role: "bot",
      blocks: [block],
      clientNonce: nonce,
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: target.spaceId,
      threadId: target.threadId,
      botId: target.botId,
      runId: target.id,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "bot", blocks: [block] },
    });
    return event;
  });
  if (committed) await deps.events.notify(target.threadId, committed.seq);
  return {
    status: "pending",
    message: committed
      ? "Connection card shown. Wait for the user to connect the app."
      : "Connection card already shown. Wait for the user to connect the app.",
  };
}
