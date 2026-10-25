import { ORPCError } from "@orpc/server";
import type {
  AdapterContext,
  AgentHomeStore,
  ArtifactStore,
  ConnectorCatalogItem,
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
import {
  pickReusableConnection,
  planLiveConnectionSync,
  prepareManagedConnectorForTransaction,
  resolveBotWorkspacePath,
  sanitizeComposioError,
} from "@rakazo/adapters";
import type { Auth } from "@rakazo/auth";
import type { Actor, ExportManifest } from "@rakazo/contracts";
import { attachmentMaxBytes } from "@rakazo/contracts";
import { AttachmentValidationError, displayName } from "@rakazo/core";
import type { BoardEvents, Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  crossSpaceCommunicationAllowed,
  formatMessagingLinkCode,
  IsolationError,
  issueMessagingLinkCode,
  parseComputerMode,
  recordSecurityEvent,
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
import { connectionCreatedEvent } from "./security-audit.js";
import { loadAllMessages } from "./thread-message-pages.js";

export { nextConnectionLabel } from "./model-credentials.js";
export { botIntroPrompt, enqueueBotIntroRun } from "./routes/bots.js";
export { HEARTBEAT_MS, SESSION_RECHECK_MS } from "./routes/shared.js";
export { callMarkerClientNonce } from "./routes/threads.js";

const EXPORT_MESSAGE_PAGE_SIZE = 500;

async function reconcileConnections(
  prisma: PrismaClient,
  owner: Pick<Actor, "spaceId" | "userId">,
  connectorId: string,
  connectedProviders: string[],
  reconnectRefs: string[],
): Promise<void> {
  const connectedProviderKeys = new Set(
    connectedProviders.map((provider) => provider.trim().toLowerCase()),
  );
  const rows = (
    await prisma.connection.findMany({
      where: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        connectorId,
        status: { in: ["pending", "connected"] },
      },
      select: { id: true, provider: true, displayName: true, status: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })
  ).filter((row: { provider: string }) =>
    connectedProviderKeys.has(row.provider.trim().toLowerCase()),
  );
  const sync = planLiveConnectionSync(rows, connectedProviders);
  // One update per row so the credential event goes only to rows this call actually connected.
  const connectedIds: string[] = [];
  const updates = [
    ...sync.connectIds.map((id) => async (tx: Prisma.TransactionClient) => {
      const updated = await tx.connection.updateMany({
        where: { id, spaceId: owner.spaceId, userId: owner.userId, status: "pending" },
        data: { status: "connected" },
      });
      if (updated.count > 0) connectedIds.push(id);
    }),
    ...(sync.revokeIds.length > 0
      ? [
          (tx: Prisma.TransactionClient) =>
            tx.connection.updateMany({
              where: {
                id: { in: sync.revokeIds },
                spaceId: owner.spaceId,
                userId: owner.userId,
                status: "pending",
              },
              data: { status: "revoked" },
            }),
        ]
      : []),
    // The provider reports these accounts dead, so the app offers to connect them again.
    ...(reconnectRefs.length > 0
      ? [
          (tx: Prisma.TransactionClient) =>
            tx.connection.updateMany({
              where: {
                spaceId: owner.spaceId,
                userId: owner.userId,
                connectorId,
                status: "connected",
                providerRef: { in: reconnectRefs },
              },
              data: { status: "error" },
            }),
        ]
      : []),
  ];
  // Interactive rather than a batch: a batch cannot carry the request's database context.
  if (updates.length > 0)
    await prisma.$transaction(async (tx) => {
      for (const update of updates) await update(tx);
    });
  for (const id of connectedIds) {
    await recordSecurityEvent(connectionCreatedEvent("connections.catalog", id, owner));
  }
}

/** Serialize begin/revoke for one user+provider so slug-wide remote deletes cannot race a new connect. */

function isAmbiguousRemoteRevokeFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error && typeof error.name === "string" ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|aborted|network|ECONNRESET|ECONNREFUSED|fetch failed/i.test(message);
}

/** True when a connector failed before issuing any remote DELETE. */
function isRemoteRevokePreDeleteFailure(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "remoteRevokePreDelete" in error &&
      (error as { remoteRevokePreDelete?: boolean }).remoteRevokePreDelete === true,
  );
}

function shouldRestoreLocalAfterRemoteRevokeFailure(error: unknown): boolean {
  // Pre-delete list/network failures never reached DELETE — always keep retry state.
  // Post-delete timeouts stay ambiguous and leave the row revoked.
  return isRemoteRevokePreDeleteFailure(error) || !isAmbiguousRemoteRevokeFailure(error);
}

/**
 * Concrete account ids still referenced by active local rows. When any row still
 * only has the provider slug (or no ref), orphan cleanup must not run — a sibling
 * may have created its remote account before persisting the concrete id.
 */
function concreteKeepAccountIds(
  refs: Array<string | null | undefined>,
  provider: string,
): { keepIds: string[]; canRevokeUnreferenced: boolean } {
  const keepIds: string[] = [];
  let canRevokeUnreferenced = true;
  for (const ref of refs) {
    const value = ref?.trim();
    if (!value || value === provider) {
      canRevokeUnreferenced = false;
      continue;
    }
    keepIds.push(value);
  }
  return { keepIds, canRevokeUnreferenced };
}

/** Connection flows hold the provider lock across provider calls (45s budget plus database work). */
const PROVIDER_LOCK_TRANSACTION_MS = 60_000;

async function lockProviderConnectionScope(
  tx: Prisma.TransactionClient,
  owner: Pick<Actor, "spaceId" | "userId">,
  connectorId: string,
  provider: string,
): Promise<void> {
  // Avoid NUL separators in the lock key; text params may truncate at a zero byte and break begin.
  const scope = `space:${owner.spaceId}|user:${owner.userId}|connector:${connectorId}|provider:${provider}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('connection-provider'), hashtext(${scope}))`;
}

function connectionContext(
  actor: Pick<Actor, "spaceId" | "userId">,
  operationId: string,
  signal?: AbortSignal,
): AdapterContext {
  return {
    operationId,
    traceId: operationId,
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: signal ?? new AbortController().signal,
  };
}

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
    connections: {
      catalog: authed.connections.catalog.handler(async ({ context, input }) => {
        const adapterContext = connectionContext(
          context.actor,
          "connections.catalog",
          context.signal,
        );
        const providers = input.connectorId
          ? [deps.connectors.managed(input.connectorId)].filter(
              (provider): provider is NonNullable<typeof provider> => Boolean(provider),
            )
          : deps.connectors.managedProviders();
        const catalogs = await Promise.all(
          providers.map(async (provider): Promise<ConnectorCatalogItem[]> => {
            try {
              const [items, reconnectRefs] = await Promise.all([
                provider.catalog(adapterContext, input.query),
                provider.listReconnectRefs?.(adapterContext).catch(() => []) ?? [],
              ]);
              const nowConnected = items.filter((item) => item.connected).map((item) => item.slug);
              if (nowConnected.length > 0 || reconnectRefs.length > 0) {
                await reconcileConnections(
                  deps.prisma,
                  context.actor,
                  provider.describe().id,
                  nowConnected,
                  reconnectRefs,
                ).catch((error) => {
                  getLogger().error(
                    `${provider.describe().id} connection reconciliation failed`,
                    error,
                  );
                });
              }
              return items;
            } catch {
              return [];
            }
          }),
        );
        return catalogs.flat();
      }),
      list: authed.connections.list.handler(async ({ context }) => {
        const rows = await deps.prisma.connection.findMany({
          where: { spaceId: context.actor.spaceId, userId: context.actor.userId },
        });
        return rows.map((row) => ({
          id: row.id,
          connectorId: row.connectorId,
          provider: row.provider,
          displayName: row.displayName,
          status: row.status as "pending" | "connected" | "revoked" | "error",
          capabilities: [],
          createdAt: row.createdAt.toISOString(),
        }));
      }),
      begin: authed.connections.begin.handler(async ({ context, input }) => {
        const connector =
          deps.integrationSettings &&
          (input.connectorId === "composio" || input.connectorId === "pipedream")
            ? await deps.integrationSettings.resolve(input.connectorId)
            : deps.connectors.managed(input.connectorId);
        if (!connector) {
          throw new ORPCError("BAD_REQUEST", {
            message: `Connector ${input.connectorId} is not configured`,
          });
        }
        // Share the revoke scope lock so a slug-wide remote delete cannot miss a
        // row that is inserted after SELECT FOR UPDATE and before remote revoke.
        // Complete and revoke hold that lock across provider calls, so wait as long as they may.
        const row = await deps.prisma.$transaction(
          async (tx) => {
            await lockProviderConnectionScope(tx, context.actor, input.connectorId, input.provider);
            const existing = await tx.connection.findMany({
              where: {
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                connectorId: input.connectorId,
                provider: input.provider,
              },
              select: { id: true, status: true },
              orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
            });
            const reusable = pickReusableConnection(existing);
            if (reusable) {
              return tx.connection.update({
                where: { id: reusable.id },
                data: {
                  displayName: input.displayName,
                  status: "pending",
                  providerRef: null,
                  metadata: {},
                },
              });
            }
            return tx.connection.create({
              data: {
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                connectorId: input.connectorId,
                provider: input.provider,
                displayName: input.displayName,
                status: "pending",
              },
            });
          },
          { timeout: PROVIDER_LOCK_TRANSACTION_MS },
        );
        try {
          const auth = await connector.begin(
            {
              provider: input.provider,
              redirectUrl: `${deps.env.webOrigin}/integrations/callback`,
            },
            connectionContext(context.actor, "connections.begin", context.signal),
          );
          // Re-take the provider lock and only advance still-pending rows so a
          // concurrent revoke cannot be overwritten back to pending/connected.
          const applied = await deps.prisma.$transaction(
            async (tx) => {
              await lockProviderConnectionScope(
                tx,
                context.actor,
                input.connectorId,
                input.provider,
              );
              const updated = await tx.connection.updateMany({
                where: {
                  id: row.id,
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                  status: "pending",
                },
                data: {
                  status: auth.authorizationUrl ? "pending" : "connected",
                  providerRef: auth.state || null,
                  metadata: { state: auth.state },
                },
              });
              return updated.count > 0;
            },
            { timeout: PROVIDER_LOCK_TRANSACTION_MS },
          );
          if (applied && !auth.authorizationUrl) {
            await recordSecurityEvent(
              connectionCreatedEvent("connections.begin", row.id, context.actor),
            );
          }
          if (!applied) {
            // Revoke won the race. Clean up without a provider-wide slug delete.
            const state = auth.state?.trim();
            const adapterContext = connectionContext(
              context.actor,
              "connections.begin",
              context.signal,
            );
            if (state && state !== input.provider) {
              // Composio browser OAuth stores an authorization-request id in
              // auth.state. Prefer canceling that pending request by id so the
              // authorization URL cannot later create an untracked remote. The
              // request id is the connected-account nanoid (INITIATED until OAuth
              // finishes). Fall back to resolving an ACTIVE account id only when
              // cancel is unavailable.
              const cancelAuthorizationRequest = (
                connector as {
                  cancelAuthorizationRequest?: (
                    requestId: string,
                    context: typeof adapterContext,
                  ) => Promise<void>;
                }
              ).cancelAuthorizationRequest;
              if (cancelAuthorizationRequest) {
                await cancelAuthorizationRequest(state, adapterContext).catch(() => undefined);
              } else {
                const resolveAccountId = (
                  connector as {
                    resolveConnectedAccountId?: (
                      userId: string,
                      slug: string,
                      currentRef: string | null | undefined,
                      excludeIds?: string[],
                      spaceId?: string,
                    ) => Promise<string | undefined>;
                  }
                ).resolveConnectedAccountId;
                let revokeRef = state;
                if (resolveAccountId) {
                  const resolved = await resolveAccountId(
                    context.actor.userId,
                    input.provider,
                    state,
                    [],
                    context.actor.spaceId,
                  ).catch(() => undefined);
                  if (!resolved) {
                    revokeRef = "";
                  } else {
                    revokeRef = resolved;
                  }
                }
                if (revokeRef) {
                  await connector.revoke(revokeRef, adapterContext).catch(() => undefined);
                }
              }
            } else if (state === input.provider) {
              // Pipedream begin only returns the app slug. Drop remotes that no
              // remaining local row still references so a lost race cannot leave
              // an orphan authorization, without wiping sibling accounts.
              const revokeUnreferenced = (
                connector as {
                  revokeUnreferencedAccounts?: (
                    slug: string,
                    keepAccountIds: string[],
                    context: ReturnType<typeof connectionContext>,
                  ) => Promise<void>;
                }
              ).revokeUnreferencedAccounts;
              if (revokeUnreferenced) {
                // Hold the provider lock across the keep-id snapshot and remote
                // cleanup so a concurrent complete cannot persist a providerRef
                // that this cleanup then deletes as unreferenced.
                await deps.prisma
                  .$transaction(
                    async (tx) => {
                      await lockProviderConnectionScope(
                        tx,
                        context.actor,
                        input.connectorId,
                        input.provider,
                      );
                      const kept = await tx.connection.findMany({
                        where: {
                          spaceId: context.actor.spaceId,
                          userId: context.actor.userId,
                          connectorId: input.connectorId,
                          provider: input.provider,
                          status: { in: ["connected", "pending", "error"] },
                        },
                        select: { providerRef: true },
                      });
                      const { keepIds, canRevokeUnreferenced } = concreteKeepAccountIds(
                        kept.map((entry) => entry.providerRef),
                        input.provider,
                      );
                      // Skip while any sibling still lacks a concrete account id —
                      // otherwise slug-only pending refs are dropped from keepIds and
                      // revokeUnreferencedAccounts deletes that sibling's remote auth.
                      if (!canRevokeUnreferenced) return;
                      await revokeUnreferenced(input.provider, keepIds, adapterContext);
                    },
                    { timeout: PROVIDER_LOCK_TRANSACTION_MS },
                  )
                  .catch(() => undefined);
              }
            }
            throw new IsolationError();
          }
          return { connectionId: row.id, authorizationUrl: auth.authorizationUrl };
        } catch (error) {
          if (error instanceof IsolationError) throw error;
          await deps.prisma.connection.updateMany({
            where: {
              id: row.id,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              status: "pending",
            },
            data: { status: "error" },
          });
          throw new ORPCError("BAD_REQUEST", { message: sanitizeComposioError(error) });
        }
      }),
      complete: authed.connections.complete.handler(async ({ context, input }) => {
        const existing = await deps.prisma.connection.findFirst({
          where: {
            id: input.connectionId,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
        });
        if (!existing) throw new IsolationError();
        const connector = deps.connectors.managed(existing.connectorId);
        if (!connector) {
          throw new ORPCError("BAD_REQUEST", {
            message: `Connector ${existing.connectorId} is not configured`,
          });
        }
        const prepared =
          existing.status !== "connected"
            ? await prepareManagedConnectorForTransaction(connector)
            : { provider: connector, recheck: undefined };
        const transactionConnector = prepared.provider;
        if (!transactionConnector)
          throw new ORPCError("BAD_REQUEST", { message: "Integration provider is not configured" });
        let row = existing;
        let connectedNow = false;
        if (existing.status !== "connected") {
          // Hold the provider lock across remote completion, account-id resolution,
          // providerRef persistence, and any overlapping revokeUnreferenced cleanup
          // so a concurrent begin-loss cleanup cannot delete the account we are about
          // to persist.
          row = await deps.prisma.$transaction(
            async (tx) => {
              await lockProviderConnectionScope(
                tx,
                context.actor,
                existing.connectorId,
                existing.provider,
              );
              const current = await tx.connection.findFirst({
                where: {
                  id: existing.id,
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                },
              });
              if (!current) throw new IsolationError();
              if (prepared.recheck && !(await prepared.recheck(tx))) {
                throw new ORPCError("CONFLICT", {
                  message: "Integration credentials changed; retry.",
                });
              }
              if (current.status === "connected") return current;
              if (current.status === "revoked") {
                // Authorization URLs from a revoke-win begin can still finish
                // remotely. Cancel leftover Composio request ids / drop Pipedream
                // remotes no active local row still references before rejecting.
                // Not the request signal: clients abort a poll they no longer need, and
                // that must not cut short removing the leftover remote account.
                const revokedContext = connectionContext(context.actor, "connections.complete");
                const restoreRevokedForRetry = async () => {
                  // Cleanup failed while the row is already revoked — restore pending
                  // so the UI can retry removal instead of leaving an orphan remote.
                  // Use the root client (not tx): throwing below aborts this
                  // transaction and would otherwise roll back a tx-scoped restore.
                  await deps.prisma.connection.updateMany({
                    where: {
                      id: current.id,
                      spaceId: context.actor.spaceId,
                      userId: context.actor.userId,
                      status: "revoked",
                    },
                    data: { status: "pending" },
                  });
                };
                const pendingRef = current.providerRef?.trim();
                try {
                  if (pendingRef && pendingRef !== current.provider) {
                    const cancelAuthorizationRequest = (
                      transactionConnector as {
                        cancelAuthorizationRequest?: (
                          requestId: string,
                          context: typeof revokedContext,
                        ) => Promise<void>;
                      }
                    ).cancelAuthorizationRequest;
                    if (cancelAuthorizationRequest) {
                      await cancelAuthorizationRequest(pendingRef, revokedContext);
                    } else {
                      const resolveAccountId = (
                        transactionConnector as {
                          resolveConnectedAccountId?: (
                            userId: string,
                            slug: string,
                            currentRef: string | null | undefined,
                            excludeIds?: string[],
                            spaceId?: string,
                          ) => Promise<string | undefined>;
                        }
                      ).resolveConnectedAccountId;
                      let revokeRef = pendingRef;
                      if (resolveAccountId) {
                        const resolved = await resolveAccountId(
                          context.actor.userId,
                          current.provider,
                          pendingRef,
                          [],
                          context.actor.spaceId,
                        ).catch(() => undefined);
                        revokeRef = resolved ?? "";
                      }
                      if (revokeRef) {
                        await transactionConnector.revoke(revokeRef, revokedContext);
                      }
                    }
                  } else {
                    const revokeUnreferenced = (
                      transactionConnector as {
                        revokeUnreferencedAccounts?: (
                          slug: string,
                          keepAccountIds: string[],
                          context: typeof revokedContext,
                        ) => Promise<void>;
                      }
                    ).revokeUnreferencedAccounts;
                    if (revokeUnreferenced) {
                      const kept = await tx.connection.findMany({
                        where: {
                          spaceId: context.actor.spaceId,
                          userId: context.actor.userId,
                          connectorId: existing.connectorId,
                          provider: existing.provider,
                          status: { in: ["connected", "pending", "error"] },
                        },
                        select: { providerRef: true },
                      });
                      const { keepIds, canRevokeUnreferenced } = concreteKeepAccountIds(
                        kept.map((entry) => entry.providerRef),
                        existing.provider,
                      );
                      if (canRevokeUnreferenced) {
                        await revokeUnreferenced(existing.provider, keepIds, revokedContext);
                      }
                    }
                  }
                } catch (error) {
                  getLogger().error(
                    "connections.complete remote cleanup failed for revoked row",
                    error,
                    {
                      connectionId: current.id,
                      connectorId: existing.connectorId,
                      provider: existing.provider,
                    },
                  );
                  await restoreRevokedForRetry();
                  // Still superseded: stop the poll so it cannot complete the restored row,
                  // which stays pending in the account list for removal.
                  throw new IsolationError();
                }
                // A newer attempt or a removal superseded this one. Report it so the
                // caller stops polling instead of retrying an error.
                return current;
              }

              const adapterContext = connectionContext(
                context.actor,
                "connections.complete",
                context.signal,
              );
              if (input.code) {
                const state = current.providerRef ?? current.provider;
                try {
                  await transactionConnector.complete({ state, code: input.code }, adapterContext);
                } catch (error) {
                  throw new ORPCError("BAD_REQUEST", { message: sanitizeComposioError(error) });
                }
              }
              const ready = await transactionConnector.connectionReady(
                adapterContext,
                current.provider,
              );
              if (!ready) return current;

              // Browser OAuth stores a connection-request id in providerRef from
              // begin. Resolve it to the connected-account id so revoke deletes the
              // right remote authorization. Prefer an account id not already used
              // by a sibling row for the same provider.
              const resolveAccountId = (
                transactionConnector as {
                  resolveConnectedAccountId?: (
                    userId: string,
                    slug: string,
                    currentRef: string | null | undefined,
                    excludeIds?: string[],
                    spaceId?: string,
                  ) => Promise<string | undefined>;
                  connectedAccountId?: (
                    userId: string,
                    slug: string,
                  ) => Promise<string | undefined>;
                }
              ).resolveConnectedAccountId;
              const fallbackAccountId = (
                transactionConnector as {
                  connectedAccountId?: (
                    userId: string,
                    slug: string,
                  ) => Promise<string | undefined>;
                }
              ).connectedAccountId;
              let resolvedAccountId: string | undefined;
              if (resolveAccountId || fallbackAccountId) {
                const siblings = await tx.connection.findMany({
                  where: {
                    spaceId: context.actor.spaceId,
                    userId: context.actor.userId,
                    connectorId: existing.connectorId,
                    provider: existing.provider,
                    id: { not: existing.id },
                    status: { in: ["connected", "pending", "error"] },
                  },
                  select: { providerRef: true },
                });
                // Exclude concrete account ids only. A pending sibling may still
                // store a slug or authorization-request id; passing those raw refs
                // would not match remote account ids and can let this row adopt the
                // sibling's account. If a sibling ref cannot be resolved yet, leave
                // this row pending so a later complete can re-resolve safely.
                const excludeIds: string[] = [];
                let unresolvedSibling = false;
                for (const sibling of siblings) {
                  const ref = sibling.providerRef?.trim();
                  // Slug-only refs cannot identify a concrete remote account; resolving
                  // them would pick an arbitrary ACTIVE id and over-exclude.
                  if (!ref || ref === existing.provider) continue;
                  if (resolveAccountId) {
                    const resolvedSiblingId = await resolveAccountId(
                      context.actor.userId,
                      existing.provider,
                      ref,
                      [],
                      context.actor.spaceId,
                    ).catch(() => undefined);
                    if (resolvedSiblingId) {
                      excludeIds.push(resolvedSiblingId);
                    } else {
                      unresolvedSibling = true;
                    }
                  } else {
                    excludeIds.push(ref);
                  }
                }
                if (unresolvedSibling) {
                  return current;
                }
                resolvedAccountId = resolveAccountId
                  ? await resolveAccountId(
                      context.actor.userId,
                      existing.provider,
                      current.providerRef,
                      excludeIds,
                      context.actor.spaceId,
                    ).catch(() => undefined)
                  : await fallbackAccountId!(context.actor.userId, existing.provider).catch(
                      () => undefined,
                    );
              }

              // When a resolver exists and providerRef is still a request-scoped
              // id (not the provider slug), require a concrete account id before
              // marking connected — otherwise revoke would delete the wrong ref.
              if (
                resolveAccountId &&
                current.providerRef &&
                current.providerRef !== current.provider &&
                !resolvedAccountId
              ) {
                return current;
              }

              const providerRef = resolvedAccountId ?? current.providerRef;
              if (providerRef) {
                const taken = await tx.connection.findFirst({
                  where: {
                    spaceId: context.actor.spaceId,
                    userId: context.actor.userId,
                    connectorId: existing.connectorId,
                    provider: existing.provider,
                    id: { not: existing.id },
                    status: { in: ["connected", "pending", "error"] },
                    providerRef,
                  },
                  select: { id: true },
                });
                if (taken) {
                  // Do not mark connected with a request-scoped or shared ref —
                  // leave pending so a later complete can re-resolve an unused id.
                  return current;
                }
              }
              // Catalog reconciliation does not take the provider lock, so it may have
              // connected this row meanwhile; only the call that changes it records the event.
              const updated = await tx.connection.updateMany({
                where: { id: current.id, status: current.status },
                data: {
                  status: "connected",
                  ...(providerRef ? { providerRef } : {}),
                },
              });
              connectedNow = updated.count > 0;
              if (!connectedNow && providerRef) {
                // Reconciliation sets only the status; keep the resolved account id so
                // revoke still deletes the right remote account.
                await tx.connection.updateMany({
                  where: { id: current.id, status: "connected" },
                  data: { providerRef },
                });
              }
              const next = await tx.connection.findFirst({
                where: {
                  id: current.id,
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                },
              });
              if (!next) throw new IsolationError();
              return next;
            },
            { timeout: PROVIDER_LOCK_TRANSACTION_MS },
          );
        }
        // Clients poll this procedure, so it records the credential once, on the transition.
        if (connectedNow) {
          await recordSecurityEvent(
            connectionCreatedEvent("connections.complete", row.id, context.actor),
          );
        }
        return {
          id: row.id,
          connectorId: row.connectorId,
          provider: row.provider,
          displayName: row.displayName,
          status: row.status as "pending" | "connected" | "revoked" | "error",
          capabilities: [],
          createdAt: row.createdAt.toISOString(),
        };
      }),
      rename: authed.connections.rename.handler(async ({ context, input }) => {
        const existing = await deps.prisma.connection.findFirst({
          where: {
            id: input.connectionId,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
        });
        if (!existing) throw new IsolationError();
        const row = await deps.prisma.connection.update({
          where: { id: existing.id },
          data: { displayName: input.displayName },
        });
        return {
          id: row.id,
          connectorId: row.connectorId,
          provider: row.provider,
          displayName: row.displayName,
          status: row.status as "pending" | "connected" | "revoked" | "error",
          capabilities: [],
          createdAt: row.createdAt.toISOString(),
        };
      }),
      revoke: authed.connections.revoke.handler(async ({ context, input }) => {
        type RemoteRevoke = {
          connectorId: string;
          connectionRef: string;
          accountSpecific: boolean;
        };
        const snapshot = await deps.prisma.connection.findFirst({
          where: {
            id: input.connectionId,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
        });
        const needsProvider =
          snapshot &&
          ["connected", "pending", "error"].includes(snapshot.status) &&
          (!snapshot.providerRef || snapshot.providerRef === snapshot.provider) &&
          (await deps.prisma.connection.count({
            where: {
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              connectorId: snapshot.connectorId,
              provider: snapshot.provider,
              id: { not: snapshot.id },
              status: { in: ["connected", "pending"] },
            },
          })) === 0;
        const configured = needsProvider
          ? deps.connectors.managed(snapshot.connectorId)
          : undefined;
        const prepared = configured
          ? await prepareManagedConnectorForTransaction(configured)
          : undefined;
        const outcome = await deps.prisma.$transaction(
          async (tx) => {
            const row = await tx.connection.findFirst({
              where: {
                id: input.connectionId,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
            });
            if (!row) {
              return {
                remote: null as null | RemoteRevoke,
                previousStatus: null as string | null,
              };
            }

            // Advisory lock covers inserts as well as existing rows. SELECT FOR UPDATE
            // alone misses a concurrent begin that inserts after the lock query.
            await lockProviderConnectionScope(tx, context.actor, row.connectorId, row.provider);
            await tx.$queryRaw`
              SELECT id
              FROM connections
              WHERE "spaceId" = ${context.actor.spaceId}
                AND "userId" = ${context.actor.userId}
                AND "connectorId" = ${row.connectorId}
                AND provider = ${row.provider}
                AND status IN ('connected', 'pending', 'error')
              FOR UPDATE`;

            const updated = await tx.connection.updateMany({
              where: {
                id: row.id,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                status: { in: ["connected", "pending", "error"] },
              },
              data: { status: "revoked" },
            });
            if (updated.count === 0) {
              return {
                remote: null as null | RemoteRevoke,
                previousStatus: null as string | null,
              };
            }

            const remaining = await tx.connection.count({
              where: {
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                connectorId: row.connectorId,
                provider: row.provider,
                status: { in: ["connected", "pending"] },
              },
            });
            const connectionRef = row.providerRef || row.provider;
            const accountSpecific = Boolean(row.providerRef && row.providerRef !== row.provider);
            // Account-scoped refs can disconnect one remote authorization while
            // siblings remain. Slug-only legacy rows must wait until they are last,
            // or a provider-wide revoke would drop every account for that app.
            if (!accountSpecific && remaining > 0) {
              return {
                remote: null as null | RemoteRevoke,
                previousStatus: null as string | null,
              };
            }

            // Slug-only remote delete is provider-wide. Run it before commit while
            // still holding the begin/revoke lock so a new authorization cannot be
            // created and then wiped by Pipedream's slug-scoped DELETE.
            if (!accountSpecific) {
              if (
                !needsProvider ||
                row.connectorId !== snapshot?.connectorId ||
                row.provider !== snapshot?.provider ||
                (prepared?.recheck && !(await prepared.recheck(tx)))
              ) {
                throw new ORPCError("CONFLICT", {
                  message: "Integration credentials changed; retry.",
                });
              }
              const connector = prepared?.provider;
              if (!connector) {
                throw new ORPCError("BAD_REQUEST", {
                  message: `Connector ${row.connectorId} is not configured`,
                });
              }
              try {
                // Abort before the 60s Prisma transaction timeout so a late remote
                // delete cannot succeed after local status has already rolled back.
                const signals = [AbortSignal.timeout(45_000)];
                if (context.signal) signals.unshift(context.signal);
                const revokeSignal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
                await connector.revoke(
                  connectionRef,
                  connectionContext(context.actor, "connections.revoke", revokeSignal),
                );
              } catch (error) {
                if (error instanceof ORPCError) throw error;
                throw new ORPCError("BAD_REQUEST", { message: sanitizeComposioError(error) });
              }
              return {
                remote: null as null | RemoteRevoke,
                previousStatus: null as string | null,
              };
            }

            return {
              remote: {
                connectorId: row.connectorId,
                connectionRef,
                accountSpecific,
              },
              previousStatus: row.status,
            };
          },
          { timeout: PROVIDER_LOCK_TRANSACTION_MS },
        );

        if (outcome.remote) {
          const restoreLocalStatus = async () => {
            // Local row was marked revoked inside the transaction; restore it so a
            // failed remote disconnect remains retryable instead of orphaned.
            if (!outcome.previousStatus) return;
            await deps.prisma.connection.updateMany({
              where: {
                id: input.connectionId,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                status: "revoked",
              },
              data: { status: outcome.previousStatus },
            });
          };
          try {
            const connector = deps.connectors.managed(outcome.remote.connectorId);
            if (!connector) {
              throw new ORPCError("BAD_REQUEST", {
                message: `Connector ${outcome.remote.connectorId} is not configured`,
              });
            }
            await connector.revoke(
              outcome.remote.connectionRef,
              connectionContext(context.actor, "connections.revoke", context.signal),
            );
          } catch (error) {
            // Restore when DELETE clearly did not run (including pre-delete list
            // timeouts). Post-delete timeouts stay ambiguous — leave revoked.
            if (shouldRestoreLocalAfterRemoteRevokeFailure(error)) {
              await restoreLocalStatus();
            } else {
              getLogger().error(
                "connections.revoke remote outcome uncertain; leaving local revoked",
                error,
                {
                  connectionId: input.connectionId,
                  connectorId: outcome.remote.connectorId,
                },
              );
            }
            if (error instanceof ORPCError) throw error;
            throw new ORPCError("BAD_REQUEST", { message: sanitizeComposioError(error) });
          }
        }
        return { ok: true as const };
      }),
      tools: authed.connections.tools.handler(async ({ context, input }) => {
        const connector = deps.connectors.managed(input.connectorId);
        if (!connector) return [];
        const row = await deps.prisma.connection.findFirst({
          where: {
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
            connectorId: input.connectorId,
            provider: input.provider,
            status: "connected",
          },
        });
        if (!row) return [];
        try {
          const tools = await connector.discoverTools({
            ...connectionContext(context.actor, "connections.tools", context.signal),
            connectedConnections: [
              {
                id: row.id,
                connectorId: input.connectorId,
                externalId: input.provider,
                displayName: row.displayName,
                providerRef: row.providerRef ?? undefined,
              },
            ],
            connectedProviders: [input.provider],
          });
          return tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
          }));
        } catch (error) {
          getLogger().error("connections.tools failed", error, {
            connectorId: input.connectorId,
            provider: input.provider,
          });
          return [];
        }
      }),
    },
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
