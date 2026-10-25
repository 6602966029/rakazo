import { ORPCError } from "@orpc/server";
import type {
  AgentHomeStore,
  ArtifactStore,
  JobPublisher,
  MemoryStore,
  ProductAnalytics,
  SandboxProvider,
  SecretStore,
  UsageOperationKind,
} from "@rakazo/adapter-kit";
import { messagingDeliverJob } from "@rakazo/adapter-kit";
import type {
  CloudAgentConnection,
  CodexLiveCatalog,
  ComposioProvider,
  ConnectorRegistry,
  FaviconResolver,
  IntegrationProviderSettings,
  McpConnector,
  McpOAuthBroker,
  MemoryProviderResolver,
  PiOAuthLogins,
  ProviderCatalogCache,
  PushTokenStore,
  RemoteConnectorDependencies,
  TicketChangeNotifier,
} from "@rakazo/adapters";
import { resolveBotWorkspacePath } from "@rakazo/adapters";
import type { Auth } from "@rakazo/auth";
import type { ExportManifest } from "@rakazo/contracts";
import { attachmentMaxBytes } from "@rakazo/contracts";
import { AttachmentValidationError, displayName } from "@rakazo/core";
import type { BoardEvents, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  crossSpaceCommunicationAllowed,
  formatMessagingLinkCode,
  IsolationError,
  issueMessagingLinkCode,
  parseComputerMode,
  runAsSystem,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  ArtifactListCursorError,
  createOwnedArtifact,
  deleteArtifactFamily,
  getOwnedArtifact,
  getSpaceArtifact,
  getSpaceArtifactById,
  listArtifactVersions,
  listSpaceArtifacts,
} from "./artifacts.js";
import type { BillingService } from "./billing.js";
import { accountRoutes } from "./routes/account.js";
import { boardsRoutes } from "./routes/boards.js";
import { botsRoutes } from "./routes/bots.js";
import { computerRoutes } from "./routes/computer.js";
import { connectionsRoutes } from "./routes/connections.js";
import { createRouterContext } from "./routes/context.js";
import { mcpRoutes } from "./routes/mcp.js";
import { memoryRoutes } from "./routes/memory.js";
import { modelsRoutes } from "./routes/models.js";
import { routinesRoutes } from "./routes/routines.js";
import { isUniqueViolation } from "./routes/shared.js";
import { spacesRoutes } from "./routes/spaces.js";
import { threadsRoutes } from "./routes/threads.js";
import { listSpaceRuns } from "./runs.js";
import { querySpaceSearch } from "./search.js";
import { loadAllMessages } from "./thread-message-pages.js";

export { nextConnectionLabel } from "./model-credentials.js";
export { botIntroPrompt, enqueueBotIntroRun } from "./routes/bots.js";
export { HEARTBEAT_MS, SESSION_RECHECK_MS } from "./routes/shared.js";
export { callMarkerClientNonce } from "./routes/threads.js";

const EXPORT_MESSAGE_PAGE_SIZE = 500;

export interface RouterDeps {
  pushTokens: PushTokenStore;
  analytics?: ProductAnalytics;
  cloudAgent?: CloudAgentConnection | null;
  prisma: PrismaClient;
  events: ThreadEvents;
  boardEvents: BoardEvents;
  ticketChanges: TicketChangeNotifier;
  auth: Auth;
  jobs: JobPublisher;
  sandbox: SandboxProvider;
  memory: MemoryStore;
  memoryProviders: MemoryProviderResolver;
  home: AgentHomeStore;
  secrets: SecretStore;
  oauthLogins: PiOAuthLogins;
  /** Live Codex catalog seam; defaults to the shared per-process cache. */
  codexCatalog?: CodexLiveCatalog;
  providerCatalog?: ProviderCatalogCache;
  /** HTTP transport for model connection checks and catalog probes. */
  modelConnectionFetch?: typeof fetch;
  /** Site icons for links; defaults to the per-process cache that fetches them. */
  favicons?: FaviconResolver;
  /**
   * Detached refresh for a stored credential whose bearer expired — the live
   * catalog path calls it instead of refreshing inline. Defaults to the
   * runtime's locked `kickModelCredentialRefresh`; injectable for tests so a
   * catalog read never reaches the real OAuth refresh endpoint.
   */
  refreshExpiredModelCredential?: (
    scope: { userId: string; spaceId: string },
    secretId: string,
    provider: string,
  ) => void;
  integrationSettings?: IntegrationProviderSettings;
  composio?: ComposioProvider;
  mcpOAuth?: McpOAuthBroker;
  /**
   * The API process's MCP connector, used to launch/list an MCP server once so its health
   * is visible (`mcp.servers.test` and the probe after create/update/OAuth). Without it
   * servers are simply never probed from here.
   */
  mcp?: Pick<McpConnector, "probe">;
  connectors: ConnectorRegistry;
  remoteConnectors?: RemoteConnectorDependencies;
  artifacts: ArtifactStore;
  dataDir: string;
  /** Present when the external messaging surface is enabled. */
  messaging?: { enabled: boolean; providers: string[]; openSignup: boolean };
  /** Present only when the deployment bills; self-hosted installs leave it unset. */
  billing?: BillingService;
  env: {
    ticketBoardEnabled?: boolean;
    phoneCallsEnabled?: boolean;
    phoneCallRingSeconds?: number;
    maxUploadSizeBytes?: number;
    agentRuntime: string;
    teamChatJudgeProvider?: string;
    teamChatJudgeModel?: string;
    defaultProvider: string;
    defaultModel: string;
    deploymentModelConfigured?: boolean;
    deploymentModelHostCredentials?: boolean;
    webOrigin: string;
    privacyPolicyUrl?: string;
    screenProxySecret: string;
    sandboxProvider: string;
    gitSha?: string;
    integrationsCatalogUrl?: string;
    mcpAllowPrivateEndpoint?: boolean;
    desktopHostChoiceEnabled?: boolean;
    /** Whether MCP stdio servers can run, and the commands they may launch. */
    mcpStdioEnabled?: boolean;
    mcpStdioAllowedCommands?: string[];
  };
}

export function createRouter(deps: RouterDeps) {
  const ctx = createRouterContext(deps);
  const { os, repos, favicons, groupRepos, authed } = ctx;

  return os.router({
    ...accountRoutes(ctx),
    ...spacesRoutes(ctx),
    ...modelsRoutes(ctx),
    ...botsRoutes(ctx),
    ...threadsRoutes(ctx),
    ...computerRoutes(ctx),
    ...memoryRoutes(ctx),
    ...routinesRoutes(ctx),
    ...boardsRoutes(ctx),
    ...mcpRoutes(ctx),
    ...connectionsRoutes(ctx),
    messaging: {
      status: authed.messaging.status.handler(async ({ context }) => {
        const identities = await acrossChatIdentities(() =>
          deps.prisma.messagingIdentity.findMany({
            where: { userId: context.actor.userId },
            orderBy: { createdAt: "asc" },
          }),
        );
        return {
          enabled: deps.messaging?.enabled ?? false,
          providers: deps.messaging?.providers ?? [],
          openSignup: deps.messaging?.openSignup ?? false,
          identities: await Promise.all(
            identities.map((identity) => messagingIdentityDto(deps.prisma, identity)),
          ),
        };
      }),
      link: {
        start: authed.messaging.link.start.handler(async ({ context, input }) => {
          const bot = await deps.prisma.bot.findFirst({
            where: {
              id: input.botId,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              archivedAt: null,
            },
            select: { id: true },
          });
          if (!bot) throw new ORPCError("NOT_FOUND");
          // One chat identity per bot: delivery mirrors a bot's replies to
          // exactly one conversation.
          const linked = await deps.prisma.messagingIdentity.findUnique({
            where: { botId: bot.id },
            select: { id: true },
          });
          if (linked) {
            throw new ORPCError("BAD_REQUEST", {
              message: "That bot is already linked to a chat app; unlink it first.",
            });
          }
          const issued = await issueMessagingLinkCode(deps.prisma, {
            userId: context.actor.userId,
            spaceId: context.actor.spaceId,
            botId: bot.id,
          });
          return {
            code: formatMessagingLinkCode(issued.code),
            expiresAt: issued.expiresAt.toISOString(),
          };
        }),
      },
      identities: {
        setBot: authed.messaging.identities.setBot.handler(async ({ context, input }) => {
          const identity = await acrossChatIdentities(() =>
            deps.prisma.messagingIdentity.findFirst({
              where: { id: input.identityId, userId: context.actor.userId },
            }),
          );
          if (!identity) throw new ORPCError("NOT_FOUND");
          const bot = await deps.prisma.bot.findFirst({
            where: {
              id: input.botId,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              archivedAt: null,
            },
            select: { id: true },
          });
          if (!bot) throw new ORPCError("NOT_FOUND");
          try {
            const updated = await acrossChatIdentities(() =>
              deps.prisma.messagingIdentity.update({
                where: { id: identity.id },
                // The identity must live in the bot's space: runs resolve
                // credentials, memory, and approval rules from run.spaceId.
                data: { botId: bot.id, spaceId: context.actor.spaceId },
              }),
            );
            return messagingIdentityDto(deps.prisma, updated);
          } catch (error) {
            // botId is unique: the target bot is already linked elsewhere.
            if (isUniqueViolation(error)) {
              throw new ORPCError("BAD_REQUEST", {
                message: "That bot is already linked to a chat app.",
              });
            }
            throw error;
          }
        }),
        unlink: authed.messaging.identities.unlink.handler(async ({ context, input }) => {
          const { count } = await acrossChatIdentities(() =>
            deps.prisma.messagingIdentity.deleteMany({
              where: { id: input.identityId, userId: context.actor.userId },
            }),
          );
          if (count === 0) throw new ORPCError("NOT_FOUND");
          return { ok: true as const };
        }),
      },
      channels: {
        list: authed.messaging.channels.list.handler(async ({ context }) => {
          const identities = await messagingIdentitiesFor(deps.prisma, context.actor.userId);
          if (identities.length === 0) return [];
          const memberships = await deps.prisma.messagingChannelMember.findMany({
            where: { identityId: { in: identities.map((identity) => identity.id) } },
            include: { channel: { include: { members: ACTIVE_CHANNEL_MEMBERS } } },
            orderBy: { updatedAt: "desc" },
          });
          return memberships.map((membership) => messagingChannelDto(membership));
        }),
        respond: authed.messaging.channels.respond.handler(async ({ context, input }) => {
          const identities = await messagingIdentitiesFor(deps.prisma, context.actor.userId);
          const membership = identities.length
            ? await deps.prisma.messagingChannelMember.findFirst({
                where: {
                  id: input.membershipId,
                  identityId: { in: identities.map((identity) => identity.id) },
                },
                include: { channel: { include: { members: ACTIVE_CHANNEL_MEMBERS } } },
              })
            : null;
          if (membership?.status !== "invited") {
            throw new ORPCError("NOT_FOUND");
          }
          const { count } = await deps.prisma.messagingChannelMember.updateMany({
            where: { id: membership.id, status: "invited" },
            data: { status: input.accept ? "approved" : "declined" },
          });
          if (count === 0) {
            // Lost a race with leave/sweep: approval must not resurrect a
            // departed member.
            throw new ORPCError("NOT_FOUND");
          }
          const updated = await deps.prisma.messagingChannelMember.findUniqueOrThrow({
            where: { id: membership.id },
            include: { channel: { include: { members: ACTIVE_CHANNEL_MEMBERS } } },
          });
          return messagingChannelDto(updated);
        }),
        leave: authed.messaging.channels.leave.handler(async ({ context, input }) => {
          const identities = await messagingIdentitiesFor(deps.prisma, context.actor.userId);
          const membership = identities.length
            ? await deps.prisma.messagingChannelMember.findFirst({
                where: {
                  id: input.membershipId,
                  identityId: { in: identities.map((identity) => identity.id) },
                },
              })
            : null;
          if (!membership) throw new ORPCError("NOT_FOUND");
          await deps.prisma.messagingChannelMember.update({
            where: { id: membership.id },
            data: { status: "left" },
          });
          return { ok: true as const };
        }),
      },
      connections: {
        list: authed.messaging.connections.list.handler(async ({ context }) => {
          const identities = await messagingIdentitiesFor(deps.prisma, context.actor.userId);
          if (identities.length === 0) return [];
          const botIds = identities.map((identity) => identity.botId);
          const connections = await deps.prisma.agentConnection.findMany({
            where: {
              OR: [{ requesterBotId: { in: botIds } }, { targetBotId: { in: botIds } }],
            },
            orderBy: { updatedAt: "desc" },
          });
          const myBotIds = new Set(botIds);
          return Promise.all(
            connections.map((connection) =>
              messagingConnectionDto(deps.prisma, myBotIds, connection),
            ),
          );
        }),
        respond: authed.messaging.connections.respond.handler(async ({ context, input }) => {
          const identities = await messagingIdentitiesFor(deps.prisma, context.actor.userId);
          const myBotIds = new Set(identities.map((identity) => identity.botId));
          const connection = identities.length
            ? await deps.prisma.agentConnection.findFirst({
                where: {
                  id: input.connectionId,
                  targetBotId: { in: [...myBotIds] },
                  status: "pending",
                },
              })
            : null;
          if (!connection) throw new ORPCError("NOT_FOUND");
          const { updated, notifyRequester } = await acrossChatIdentities(() =>
            deps.prisma.$transaction(async (tx) => {
              // The claim holds the connection row lock through commit, so a
              // revoke either beats it or waits — it can never interleave with
              // the confirmation write below.
              if (
                input.accept &&
                !(await crossSpaceCommunicationAllowed(
                  tx,
                  connection.requesterBotId,
                  connection.targetBotId,
                ))
              ) {
                throw new ORPCError("FORBIDDEN");
              }
              const { count } = await tx.agentConnection.updateMany({
                where: { id: connection.id, status: "pending" },
                data: { status: input.accept ? "approved" : "declined" },
              });
              if (count === 0) {
                // Lost a race with revoke: approval must never overwrite it.
                throw new ORPCError("NOT_FOUND");
              }
              const row = await tx.agentConnection.findUniqueOrThrow({
                where: { id: connection.id },
              });
              if (!input.accept) return { updated: row, notifyRequester: false };
              // Parity with the text-command path: the requester hears about it.
              const requesterIdentity = await tx.messagingIdentity.findUnique({
                where: { botId: connection.requesterBotId },
              });
              if (!requesterIdentity) return { updated: row, notifyRequester: false };
              const key = `command:connected:${connection.id}`;
              // A re-approved pair starts a fresh cycle; clear the stale row or
              // skipDuplicates would swallow the new confirmation.
              await tx.messagingOutbound.deleteMany({ where: { idempotencyKey: key } });
              await tx.messagingOutbound.createMany({
                data: [
                  {
                    idempotencyKey: key,
                    kind: "dm",
                    identityId: requesterIdentity.id,
                    body: "Your connection request was accepted. Your agents can now message each other.",
                  },
                ],
                skipDuplicates: true,
              });
              return { updated: row, notifyRequester: true };
            }),
          );
          if (notifyRequester) {
            await deps.jobs.enqueue(messagingDeliverJob()).catch((error) => {
              getLogger().error("messaging connection confirmation enqueue error", error);
            });
          }
          return messagingConnectionDto(deps.prisma, myBotIds, updated);
        }),
        revoke: authed.messaging.connections.revoke.handler(async ({ context, input }) => {
          const identities = await messagingIdentitiesFor(deps.prisma, context.actor.userId);
          const botIds = identities.map((identity) => identity.botId);
          const connection = identities.length
            ? await deps.prisma.agentConnection.findFirst({
                where: {
                  id: input.connectionId,
                  OR: [{ requesterBotId: { in: botIds } }, { targetBotId: { in: botIds } }],
                },
              })
            : null;
          if (!connection) throw new ORPCError("NOT_FOUND");
          // Claim + invite cancel in one transaction. The status update holds
          // the connection row lock through commit, so a concurrent reconnect
          // (FOR UPDATE) waits until both the revoke and the invite delete
          // finish — otherwise it could reopen and create a fresh invite that
          // a post-commit deleteMany would then wipe while leaving the row
          // pending with no approval prompt.
          await acrossChatIdentities(() =>
            deps.prisma.$transaction(async (tx) => {
              const { count } = await tx.agentConnection.updateMany({
                where: { id: connection.id, status: connection.status },
                data: { status: "revoked" },
              });
              if (count === 0) throw new ORPCError("NOT_FOUND");
              // Cancel undelivered invites, including rows the drain already
              // claimed (status sent, no providerHandle yet). Connect-invite
              // delivery holds this connection row FOR UPDATE through
              // sendDirect, so revoke either waits until the DM is sent or
              // deletes the claim before send starts.
              await tx.messagingOutbound.deleteMany({
                where: {
                  idempotencyKey: `connect:${connection.requesterBotId}:${connection.targetBotId}`,
                  OR: [{ status: "pending" }, { status: "sent", providerHandle: null }],
                },
              });
            }),
          );
          return { ok: true as const };
        }),
      },
    },
    artifacts: {
      list: authed.artifacts.list.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        const rows = await deps.prisma.artifact.findMany({
          where: {
            botId: input.botId,
            groupId: null,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
        });
        return rows.map((row) => ({
          id: row.id,
          botId: row.botId,
          groupId: row.groupId,
          runId: row.runId,
          name: row.name,
          description: row.description,
          mimeType: row.mimeType,
          size: row.size,
          version: row.version,
          createdAt: row.createdAt.toISOString(),
        }));
      }),
      listSpace: authed.artifacts.listSpace.handler(async ({ context, input }) => {
        if (input.botId) await repos.getBot(context.actor, input.botId);
        try {
          return await listSpaceArtifacts(deps, context.actor, input);
        } catch (error) {
          if (error instanceof ArtifactListCursorError) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
          }
          throw error;
        }
      }),
      listVersions: authed.artifacts.listVersions.handler(async ({ context, input }) => {
        return listArtifactVersions(deps, context.actor, input);
      }),
      create: authed.artifacts.create.handler(async ({ context, input }) => {
        const botId = input.botId
          ? (await repos.getBot(context.actor, input.botId)).id
          : (await groupRepos.getGroupTarget(context.actor, input.groupId!)).members[0]?.bot.id;
        if (!botId) throw new IsolationError();
        try {
          return await createOwnedArtifact(
            { ...deps, maxUploadSizeBytes: attachmentMaxBytes(deps.env) },
            context.actor,
            { ...input, botId },
          );
        } catch (error) {
          if (error instanceof AttachmentValidationError) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
          }
          throw error;
        }
      }),
      get: authed.artifacts.get.handler(async ({ context, input }) => {
        if (input.groupId) {
          const group = await groupRepos.getGroupTarget(context.actor, input.groupId);
          const contextBotId = group.members[0]?.bot.id;
          if (!contextBotId) throw new IsolationError();
          return getSpaceArtifact(deps, context.actor, {
            artifactId: input.artifactId,
            groupId: input.groupId,
            contextBotId,
          });
        }
        await repos.getBot(context.actor, input.botId!);
        try {
          return await getOwnedArtifact(deps, context.actor, {
            botId: input.botId!,
            artifactId: input.artifactId,
          });
        } catch (error) {
          if (error instanceof IsolationError) throw error;
          throw error;
        }
      }),
      getById: authed.artifacts.getById.handler(async ({ context, input }) => {
        return getSpaceArtifactById(deps, context.actor, input);
      }),
      remove: authed.artifacts.remove.handler(async ({ context, input }) => {
        return deleteArtifactFamily(deps, context.actor, { familyId: input.artifactId });
      }),
    },
    usage: {
      list: authed.usage.list.handler(async ({ context }) => {
        const rows = await deps.prisma.usageRecord.findMany({
          where: { spaceId: context.actor.spaceId, userId: context.actor.userId },
          orderBy: { createdAt: "desc" },
          take: 100,
        });
        return rows.map((row) => ({
          id: row.id,
          botId: row.botId,
          runId: row.runId,
          provider: row.provider,
          model: row.model,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cacheReadTokens: row.cacheReadTokens,
          cacheWriteTokens: row.cacheWriteTokens,
          cacheWrite1hTokens: row.cacheWrite1hTokens,
          reasoningTokens: row.reasoningTokens,
          totalTokens: row.totalTokens,
          costUsd: row.costUsd,
          costSource: row.costSource,
          pricingVersion: row.pricingVersion,
          usageSource: row.usageSource,
          callId: row.callId,
          operationId: row.operationId,
          operationKind: row.operationKind as UsageOperationKind,
          parentRunId: row.parentRunId,
          agentId: row.agentId,
          createdAt: row.createdAt.toISOString(),
        }));
      }),
      summary: authed.usage.summary.handler(async ({ context }) => {
        const where = { spaceId: context.actor.spaceId, userId: context.actor.userId };
        const sums = {
          inputTokens: true,
          outputTokens: true,
          totalTokens: true,
          costUsd: true,
        } as const;
        const counts = { _all: true, ...sums } as const;
        const [result, modelGroups, runGroups] = await Promise.all([
          deps.prisma.usageRecord.aggregate({ where, _sum: sums, _count: counts }),
          deps.prisma.usageRecord.groupBy({
            by: ["provider", "model"],
            where,
            _sum: sums,
            _count: counts,
          }),
          deps.prisma.usageRecord.groupBy({ by: ["runId", "parentRunId"], where }),
        ]);
        const runs = new Set(runGroups.map((row) => row.parentRunId ?? row.runId).filter(Boolean))
          .size;
        // A total that skips rows without a count would understate spend, so it reads as unknown.
        const completeSums = (group: {
          _sum: Record<keyof typeof sums, number | null>;
          _count: Record<keyof typeof counts, number>;
        }) => {
          const complete = (field: keyof typeof sums) =>
            group._count[field] === group._count._all ? (group._sum[field] ?? 0) : null;
          return {
            inputTokens: complete("inputTokens"),
            outputTokens: complete("outputTokens"),
            totalTokens: complete("totalTokens"),
            costUsd: complete("costUsd"),
            modelCalls: group._count._all,
          };
        };
        return {
          ...completeSums(result),
          runs,
          models: modelGroups
            .map((group) => ({
              provider: group.provider,
              model: group.model,
              ...completeSums(group),
            }))
            .sort(
              (a, b) => (b.totalTokens ?? 0) - (a.totalTokens ?? 0) || b.modelCalls - a.modelCalls,
            ),
        };
      }),
    },
    export: {
      bot: authed.export.bot.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.thread || !bot.computer) throw new IsolationError();
        const homeKey = bot.computer.homeKey;
        const computerMode = parseComputerMode(bot.computer.scope);
        const exportContext = {
          operationId: "export",
          traceId: "export",
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
          signal: new AbortController().signal,
        };
        const [memory, routines, files, history] = await Promise.all([
          deps.prisma.memoryDocument.findMany({
            where: { botId: input.botId, spaceId: context.actor.spaceId },
          }),
          deps.prisma.routine.findMany({
            where: { botId: input.botId, spaceId: context.actor.spaceId },
          }),
          (async () => {
            const exported: ExportManifest["files"] = [];
            const directory = resolveBotWorkspacePath(computerMode, bot.id, "");
            // Root dotfiles contain computer state rather than portable bot files.
            for await (const file of deps.home.exportHome(homeKey, exportContext, {
              directory,
              skipHidden: true,
            })) {
              exported.push(exportFile(file.path, file.content));
            }
            return exported;
          })(),
          loadAllMessages(deps.prisma, bot.thread.id, EXPORT_MESSAGE_PAGE_SIZE),
        ]);
        return {
          version: 1 as const,
          exportedAt: new Date().toISOString(),
          bot: {
            name: bot.name,
            title: bot.title,
            description: bot.description,
            instructions: bot.instructions,
          },
          memory: memory.map((m) => ({ path: m.path, content: m.content })),
          routines: routines.map((r) => ({
            name: r.name,
            prompt: r.prompt,
            crons: r.crons,
            timezone: r.timezone,
          })),
          files,
          history,
        };
      }),
    },
    search: {
      query: authed.search.query.handler(async ({ context, input }) => ({
        hits: await querySpaceSearch(deps.prisma, context.actor, input.q),
      })),
    },
    links: {
      favicon: authed.links.favicon.handler(async ({ input }) => favicons.favicon(input.origin)),
    },
    runs: {
      list: authed.runs.list.handler(async ({ context, input }) => ({
        runs: await listSpaceRuns(deps.prisma, context.actor, input.filter),
      })),
    },
  });
}

/** Valid UTF-8 stays readable text; anything else is base64 so the bytes survive the JSON. */
function exportFile(path: string, content: Uint8Array): ExportManifest["files"][number] {
  try {
    return {
      path,
      content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content),
    };
  } catch {
    return { path, content: Buffer.from(content).toString("base64"), encoding: "base64" };
  }
}

const ACTIVE_CHANNEL_MEMBERS = {
  where: { status: { in: ["invited", "approved"] } },
  select: { id: true },
};

type MessagingIdentityRecord = {
  id: string;
  botId: string;
};

/** Every linked chat app counts: channels and connections span identities. */
async function messagingIdentitiesFor(
  prisma: PrismaClient,
  userId: string,
): Promise<MessagingIdentityRecord[]> {
  return acrossChatIdentities(() =>
    prisma.messagingIdentity.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      select: { id: true, botId: true },
    }),
  );
}

/**
 * Chat identities belong to the account, linked to bots in any of its Spaces, and an
 * agent connection joins two accounts' bots. Every query run through this names the
 * actor's own identities or bots, or a peer the actor is connected to.
 */
function acrossChatIdentities<T>(fn: () => Promise<T>): Promise<T> {
  return runAsSystem("the account's chat identities and agent connections across Spaces", fn);
}

async function messagingIdentityDto(
  prisma: PrismaClient,
  identity: { id: string; provider: string; address: string; botId: string },
) {
  const bot = await acrossChatIdentities(() =>
    prisma.bot.findUnique({
      where: { id: identity.botId },
      select: { name: true },
    }),
  );
  return {
    id: identity.id,
    provider: identity.provider,
    address: identity.address,
    botId: identity.botId,
    botName: bot?.name ?? "",
  };
}

function messagingChannelDto(membership: {
  id: string;
  channelId: string;
  // Never null here: every membership reaching this DTO was matched by one of
  // the caller's identity ids.
  identityId: string | null;
  status: string;
  channel: { provider: string; name: string | null; members: Array<{ id: string }> };
}) {
  return {
    id: membership.id,
    channelId: membership.channelId,
    identityId: membership.identityId!,
    provider: membership.channel.provider,
    name: membership.channel.name,
    status: membership.status as "invited" | "approved" | "declined" | "left",
    memberCount: membership.channel.members.length,
  };
}

async function messagingConnectionDto(
  prisma: PrismaClient,
  myBotIds: ReadonlySet<string>,
  connection: {
    id: string;
    requesterBotId: string;
    targetBotId: string;
    status: string;
  },
) {
  const incoming = myBotIds.has(connection.targetBotId);
  // The target's identity stays opaque until they approve (mirrors connect_agent).
  if (!incoming && connection.status !== "approved") {
    return {
      id: connection.id,
      peerBotName: "agent",
      peerOwnerLabel: "owner",
      status: connection.status as "pending" | "approved" | "declined" | "revoked",
      incoming,
    };
  }
  const peerBotId = incoming ? connection.requesterBotId : connection.targetBotId;
  const [peerBot, peerIdentity] = await acrossChatIdentities(() =>
    Promise.all([
      prisma.bot.findUnique({ where: { id: peerBotId }, select: { name: true } }),
      prisma.messagingIdentity.findUnique({
        where: { botId: peerBotId },
        select: { userId: true },
      }),
    ]),
  );
  const peerOwner = peerIdentity
    ? await prisma.user.findUnique({
        where: { id: peerIdentity.userId },
        select: { name: true },
      })
    : null;
  return {
    id: connection.id,
    peerBotName: peerBot?.name ?? "",
    peerOwnerLabel: displayName(peerOwner?.name, "").split(/\s+/)[0] ?? "",
    status: connection.status as "pending" | "approved" | "declined" | "revoked",
    incoming,
  };
}
