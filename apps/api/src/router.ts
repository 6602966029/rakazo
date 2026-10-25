import { createHash } from "node:crypto";
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
  persistPreparedSecret,
  pickReusableConnection,
  planLiveConnectionSync,
  prepareApiInstall,
  prepareGraphqlInstall,
  prepareManagedConnectorForTransaction,
  recordMcpServerHealth,
  resolveBotWorkspacePath,
  sanitizeComposioError,
  verifyMcpInstall,
} from "@rakazo/adapters";
import type { Auth } from "@rakazo/auth";
import type { Actor, ExportManifest } from "@rakazo/contracts";
import { attachmentMaxBytes, signupSurveyAsksTeamSize } from "@rakazo/contracts";
import { AttachmentValidationError, containsSecret, displayName } from "@rakazo/core";
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
import { searchIntegrationCatalog } from "./integration-catalog.js";
import { resolveMcpApprovalCards, revertConnectedMcpApprovals } from "./mcp-approval.js";
import { buildMcpUpdateMaterial } from "./mcp-material.js";
import {
  assertMcpOAuthTemplates,
  assertMcpRemoteEndpoint,
  MCP_OAUTH_PENDING_MESSAGE,
  mayUsePrivateEndpoint,
  mcpAssignmentDto,
  mcpServerDto,
} from "./mcp-servers.js";
import {
  chooseFocus,
  dismissFocus,
  markAppConnected,
  promptFocus,
  startOnboarding,
} from "./onboarding.js";
import { accountRoutes } from "./routes/account.js";
import { boardsRoutes } from "./routes/boards.js";
import { botsRoutes } from "./routes/bots.js";
import { computerRoutes } from "./routes/computer.js";
import { createRouterContext } from "./routes/context.js";
import { memoryRoutes } from "./routes/memory.js";
import { modelsRoutes } from "./routes/models.js";
import { routinesRoutes } from "./routes/routines.js";
import { computerContext, isUniqueViolation } from "./routes/shared.js";
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
  const {
    os,
    repos,
    onboardingDeps,
    mcpOAuth,
    mcpAwaitsOAuth,
    probeMcpServer,
    beginMcpProbe,
    removeMcpServerInTransaction,
    prepareMcpServer,
    insertMcpServer,
    announceMcpServer,
    favicons,
    groupRepos,
    authed,
  } = ctx;

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
    capabilities: {
      list: authed.capabilities.list.handler(async ({ context }) => {
        const rows = await deps.prisma.capabilityInstall.findMany({
          where: { spaceId: context.actor.spaceId, userId: context.actor.userId },
        });
        return rows.map((row) => ({
          id: row.id,
          kind: row.kind as "skill" | "plugin" | "mcp" | "api" | "connection",
          name: row.name,
          source: row.source,
          version: row.version,
          digest: row.digest,
          secretConfigured: Boolean(row.secretId),
          config: row.config as Record<string, unknown>,
          createdAt: row.createdAt.toISOString(),
        }));
      }),
      catalogSearch: authed.capabilities.catalogSearch.handler(async ({ context, input }) => {
        const baseUrl =
          deps.env.integrationsCatalogUrl ??
          (input.usePublicCatalog ? "https://integrations.sh" : undefined);
        if (!baseUrl) return { enabled: false, results: [] };
        try {
          const results = await searchIntegrationCatalog({
            baseUrl,
            query: input.query,
            signal: context.signal ?? new AbortController().signal,
            fetch: deps.remoteConnectors?.fetch,
          });
          return { enabled: true, results };
        } catch (error) {
          throw new ORPCError("BAD_GATEWAY", {
            message: error instanceof Error ? error.message : "Integration catalog search failed",
          });
        }
      }),
      install: authed.capabilities.install.handler(async ({ context, input }) => {
        let source = input.source.trim();
        let config = input.config;
        const credential = input.credential?.trim() || undefined;
        if (
          credential &&
          credential.length >= 8 &&
          (source.includes(credential) || containsSecret(config, [credential]))
        ) {
          throw new ORPCError("BAD_REQUEST", {
            message: "Put credentials only in the encrypted credential field",
          });
        }
        if (JSON.stringify(config).length > 2_000_000) {
          throw new ORPCError("BAD_REQUEST", { message: "Capability configuration is too large" });
        }
        if (
          credential &&
          input.kind !== "mcp" &&
          input.kind !== "api" &&
          input.kind !== "graphql"
        ) {
          throw new ORPCError("BAD_REQUEST", {
            message: "Credentials are only accepted for MCP, API, and GraphQL tool sources",
          });
        }
        try {
          if (input.kind === "mcp") {
            if (config.preset === "treg") {
              source = "https://treg.to/mcp/";
              config = { ...config, preset: "treg", auth: { type: "bearer" } };
            }
            const verified = await verifyMcpInstall({
              source,
              config,
              credential,
              signal: context.signal,
              remote: deps.remoteConnectors,
              allowPrivateEndpoint: mayUsePrivateEndpoint(deps),
            });
            config = verified.config;
          }
          if (input.kind === "api") {
            const prepared = await prepareApiInstall({
              source,
              config,
              credential,
              signal: context.signal,
              remote: deps.remoteConnectors,
              allowPrivateEndpoint: mayUsePrivateEndpoint(deps),
            });
            source = prepared.source;
            config = prepared.config;
          }
          if (input.kind === "graphql") {
            const prepared = await prepareGraphqlInstall({
              source,
              config,
              credential,
              signal: context.signal,
              remote: deps.remoteConnectors,
              allowPrivateEndpoint: mayUsePrivateEndpoint(deps),
            });
            source = prepared.source;
            config = prepared.config;
          }
        } catch (error) {
          const message = sanitizeComposioError(error);
          throw new ORPCError("BAD_REQUEST", {
            message: credential ? message.split(credential).join("[redacted]") : message,
          });
        }
        const stored = credential
          ? await deps.secrets.put(credential, {
              operationId: "capabilities.install",
              traceId: "capabilities.install",
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              signal: context.signal ?? new AbortController().signal,
            })
          : undefined;
        const digest = `sha256:${createHash("sha256")
          .update(JSON.stringify({ kind: input.kind, source, config }))
          .digest("hex")}`;
        const row = await deps.prisma.$transaction(async (tx) => {
          if (stored) {
            await tx.secret.create({
              data: {
                id: stored.id,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                kind: "connector",
                ciphertext: stored.ciphertext,
              },
            });
          }
          return tx.capabilityInstall.create({
            data: {
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              kind: input.kind,
              name: input.name.trim(),
              source,
              secretId: stored?.id,
              config: config as Prisma.InputJsonValue,
              digest,
              version: "1.0.0",
            },
          });
        });
        return {
          id: row.id,
          kind: row.kind as "skill" | "plugin" | "mcp" | "api" | "connection",
          name: row.name,
          source: row.source,
          version: row.version,
          digest: row.digest,
          secretConfigured: Boolean(row.secretId),
          config: row.config as Record<string, unknown>,
          createdAt: row.createdAt.toISOString(),
        };
      }),
      remove: authed.capabilities.remove.handler(async ({ context, input }) => {
        await deps.prisma.$transaction(async (tx) => {
          const existing = await tx.capabilityInstall.findFirst({
            where: {
              id: input.id,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            },
          });
          if (!existing) return;
          await tx.capabilityInstall.delete({ where: { id: existing.id } });
          if (existing.secretId) {
            const shared = await tx.capabilityInstall.count({
              where: { secretId: existing.secretId },
            });
            if (shared === 0) {
              await tx.secret.deleteMany({
                where: {
                  id: existing.secretId,
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                },
              });
            }
          }
        });
        return { ok: true as const };
      }),
    },
    mcp: {
      servers: {
        list: authed.mcp.servers.list.handler(async ({ context }) => {
          const rows = await deps.prisma.mcpServer.findMany({
            where: { spaceId: context.actor.spaceId, userId: context.actor.userId },
            orderBy: [{ name: "asc" }, { createdAt: "asc" }],
          });
          const secretIds = rows.flatMap((row) => (row.secretId ? [row.secretId] : []));
          const secrets = secretIds.length
            ? await deps.prisma.secret.findMany({
                where: {
                  id: { in: secretIds },
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                },
                select: { id: true, ciphertext: true },
              })
            : [];
          const ciphertextById = new Map(secrets.map((secret) => [secret.id, secret.ciphertext]));
          return Promise.all(
            rows.map(async (row) =>
              mcpServerDto(
                row,
                await mcpOAuth.summaryForCiphertext(
                  row.secretId ? ciphertextById.get(row.secretId) : undefined,
                  row.secretId ?? undefined,
                ),
              ),
            ),
          );
        }),
        create: authed.mcp.servers.create.handler(async ({ context, input }) => {
          const stored = await prepareMcpServer(context.actor, input);
          const row = await deps.prisma.$transaction((tx) =>
            insertMcpServer(tx, context.actor, input, stored),
          );
          return announceMcpServer(row, context.actor);
        }),
        update: authed.mcp.servers.update.handler(async ({ context, input }) => {
          for (let attempt = 0; attempt < 5; attempt++) {
            const { existing, existingSecret } = await deps.prisma.$transaction(async (tx) => {
              const existing = await tx.mcpServer.findFirst({
                where: {
                  id: input.id,
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                },
              });
              if (!existing) throw new IsolationError();
              const existingSecret = existing.secretId
                ? await tx.secret.findFirst({
                    where: {
                      id: existing.secretId,
                      spaceId: context.actor.spaceId,
                      userId: context.actor.userId,
                    },
                  })
                : null;
              return { existing, existingSecret };
            });
            let existingMaterial: Record<string, unknown> = {};
            if (existingSecret) {
              try {
                const value = JSON.parse(
                  await deps.secrets.load(existingSecret.ciphertext, existingSecret.id),
                );
                if (value && typeof value === "object" && !Array.isArray(value))
                  existingMaterial = value as Record<string, unknown>;
              } catch {
                /* Existing malformed secrets are replaced only when new credentials are supplied. */
              }
            }
            const config =
              "config" in input
                ? input.config
                : {
                    slug: existing.slug,
                    name: existing.name,
                    description: existing.description,
                    enabled: existing.enabled,
                    transport: existing.transport as "streamable_http" | "sse",
                    endpoint: existing.endpoint!,
                    headers: (existingMaterial.headers ?? {}) as Record<string, string>,
                    secret: input.secret,
                  };
            if (!("config" in input) && existing.transport === "stdio") {
              throw new ORPCError("BAD_REQUEST", { message: "A remote MCP server is required" });
            }
            const nextEndpoint = "endpoint" in config ? config.endpoint : null;
            if (existing.endpoint !== nextEndpoint) {
              await assertMcpRemoteEndpoint(nextEndpoint, deps);
            }
            if (config.transport === "stdio") {
              await assertMcpRemoteEndpoint(config.oauthClient?.authorizationServer, deps);
            }
            const endpointChanged = existing.endpoint !== nextEndpoint;
            const update = buildMcpUpdateMaterial(existingMaterial, config, {
              clearOAuth: endpointChanged,
              endpointChanged,
            });
            if (update.action === "store" && config.transport === "stdio") {
              await assertMcpRemoteEndpoint(
                update.material.oauthClient?.authorization_server,
                deps,
              );
              assertMcpOAuthTemplates(
                update.material.env ?? {},
                update.material.files ?? {},
                Boolean(update.material.oauthClient),
              );
            }
            const stored =
              update.action === "store" && Object.keys(update.material).length > 0
                ? await deps.secrets.put(
                    JSON.stringify(update.material),
                    computerContext(context.actor, "mcp", "mcp.update"),
                  )
                : null;
            const clearing = update.action === "store" && Object.keys(update.material).length === 0;
            const row = await persistPreparedSecret(
              deps.prisma,
              deps.secrets,
              stored ?? undefined,
              () =>
                deps.prisma.$transaction(async (tx) => {
                  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mcp-oauth-material'), hashtext(${input.id}))`;
                  const current = await tx.mcpServer.findFirst({
                    where: {
                      id: input.id,
                      spaceId: context.actor.spaceId,
                      userId: context.actor.userId,
                    },
                  });
                  if (!current) throw new IsolationError();
                  if (
                    current.revision !== existing.revision ||
                    current.secretId !== existing.secretId ||
                    current.endpoint !== existing.endpoint
                  )
                    return null;
                  if (current.secretId)
                    await tx.$queryRaw`SELECT id FROM secrets WHERE id = ${current.secretId} FOR UPDATE`;
                  const secret = current.secretId
                    ? await tx.secret.findFirst({
                        where: {
                          id: current.secretId,
                          spaceId: context.actor.spaceId,
                          userId: context.actor.userId,
                        },
                      })
                    : null;
                  if (secret?.ciphertext !== existingSecret?.ciphertext) return null;
                  if (stored) {
                    await tx.secret.create({
                      data: {
                        id: stored.id,
                        userId: context.actor.userId,
                        spaceId: context.actor.spaceId,
                        kind: "mcp",
                        ciphertext: stored.ciphertext,
                      },
                    });
                  }
                  const updated = await tx.mcpServer.update({
                    where: { id: existing.id },
                    data: {
                      slug: config.slug,
                      name: config.name,
                      description: config.description,
                      transport: config.transport,
                      endpoint: nextEndpoint,
                      command: "command" in config ? config.command : null,
                      args: ("args" in config ? config.args : []) as Prisma.InputJsonValue,
                      env: ("env" in config
                        ? Object.fromEntries(Object.keys(config.env).map((key) => [key, true]))
                        : {}) as Prisma.InputJsonValue,
                      // Omitted files are kept in the material, so the keys follow it.
                      ...(update.action === "store"
                        ? {
                            files: Object.fromEntries(
                              Object.keys(update.material.files ?? {}).map((key) => [key, true]),
                            ) as Prisma.InputJsonValue,
                          }
                        : {}),
                      headers: ("headers" in config
                        ? Object.fromEntries(Object.keys(config.headers).map((key) => [key, true]))
                        : {}) as Prisma.InputJsonValue,
                      enabled: config.enabled,
                      revision: { increment: 1 },
                      // The old verdict is about the old config.
                      healthStatus: "unknown",
                      healthMessage: null,
                      healthToolCount: null,
                      healthCheckedAt: null,
                      ...(stored ? { secretId: stored.id } : clearing ? { secretId: null } : {}),
                    },
                  });
                  if ((stored || clearing) && existing.secretId)
                    await tx.secret.deleteMany({
                      where: {
                        id: existing.secretId,
                        spaceId: context.actor.spaceId,
                        userId: context.actor.userId,
                      },
                    });
                  return updated;
                }),
            );
            if (row) {
              const oauth = await mcpOAuth.summaryFor(row, context.actor);
              return mcpServerDto(await beginMcpProbe(row, context.actor, oauth), oauth);
            }
          }
          throw new ORPCError("CONFLICT", { message: "MCP credentials changed; retry" });
        }),
        test: authed.mcp.servers.test.handler(async ({ context, input }) => {
          const scope = {
            id: input.id,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          };
          const server = await deps.prisma.mcpServer.findFirst({ where: scope });
          if (!server) throw new IsolationError();
          const oauth = await mcpOAuth.summaryFor(server, context.actor);
          if (!deps.mcp) {
            await recordMcpServerHealth(deps.prisma, server.id, {
              status: "error",
              message: "This server cannot be checked from here.",
            });
          } else if (await mcpAwaitsOAuth(server, context.actor, oauth)) {
            await recordMcpServerHealth(deps.prisma, server.id, {
              status: "unknown",
              message: MCP_OAUTH_PENDING_MESSAGE,
            });
          } else {
            await probeMcpServer(server, context.actor);
          }
          const fresh = await deps.prisma.mcpServer.findFirst({ where: scope });
          if (!fresh) throw new IsolationError();
          return mcpServerDto(fresh, oauth);
        }),
        remove: authed.mcp.servers.remove.handler(async ({ context, input }) => {
          const server = await deps.prisma.mcpServer.findFirst({
            where: {
              id: input.id,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            },
            select: { id: true, secretId: true },
          });
          if (!server) throw new IsolationError();
          // Assignments cascade; the encrypted credential must go with the server.
          // Cards are closed first, including ones that were never assigned.
          const seqs = await deps.prisma.$transaction((tx) =>
            removeMcpServerInTransaction(tx, context.actor, server),
          );
          for (const event of seqs) await deps.events.notify(event.threadId, event.seq);
          return { ok: true as const };
        }),
      },
      assignments: {
        all: authed.mcp.assignments.all.handler(async ({ context }) => {
          const rows = await deps.prisma.botMcpServer.findMany({
            where: {
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              bot: { archivedAt: null },
            },
            orderBy: { createdAt: "asc" },
          });
          return rows.map(mcpAssignmentDto);
        }),
        list: authed.mcp.assignments.list.handler(async ({ context, input }) => {
          const bot = await deps.prisma.bot.findFirst({
            where: {
              id: input.botId,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            },
            select: { id: true },
          });
          if (!bot) throw new IsolationError();
          const rows = await deps.prisma.botMcpServer.findMany({
            where: {
              botId: bot.id,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            },
            orderBy: { createdAt: "asc" },
          });
          return rows.map(mcpAssignmentDto);
        }),
        approve: authed.mcp.assignments.approve.handler(async ({ context, input }) => {
          const row = await resolveMcpApprovalCards(
            onboardingDeps,
            context.actor,
            {
              botId: input.botId,
              serverId: input.serverId,
              status: "connected",
              threadId: input.threadId,
            },
            async (tx, decision) => {
              if (!decision.assign) throw new IsolationError();
              const [bot, server] = await Promise.all([
                tx.bot.findFirst({
                  where: {
                    id: input.botId,
                    spaceId: context.actor.spaceId,
                    userId: context.actor.userId,
                  },
                  select: { id: true },
                }),
                tx.mcpServer.findFirst({
                  where: {
                    id: input.serverId,
                    spaceId: context.actor.spaceId,
                    userId: context.actor.userId,
                    enabled: true,
                  },
                  select: { id: true },
                }),
              ]);
              if (!bot || !server) throw new IsolationError();
              return tx.botMcpServer.upsert({
                where: { botId_serverId: { botId: bot.id, serverId: server.id } },
                create: {
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                  botId: bot.id,
                  serverId: server.id,
                  allowAllTools: true,
                  allowedTools: [],
                },
                update: {},
              });
            },
          );
          if (!row) throw new IsolationError();
          return mcpAssignmentDto(row);
        }),
        dismiss: authed.mcp.assignments.dismiss.handler(async ({ context, input }) => {
          // Not now resolves the card only. Assignments are never touched
          // here: a stale card must not delete a live connection, and server
          // removal belongs to the MCP settings surface.
          await resolveMcpApprovalCards(onboardingDeps, context.actor, {
            botId: input.botId,
            serverId: input.serverId,
            status: "dismissed",
            threadId: input.threadId,
          });
          return { ok: true as const };
        }),
        replace: authed.mcp.assignments.replace.handler(async ({ context, input }) => {
          const { rows, seqs } = await deps.prisma.$transaction(async (tx) => {
            const bot = await tx.bot.findFirst({
              where: {
                id: input.botId,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
              select: { id: true },
            });
            if (!bot) throw new IsolationError();
            const servers = await tx.mcpServer.findMany({
              where: {
                id: { in: input.assignments.map((assignment) => assignment.serverId) },
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
              select: { id: true },
            });
            if (servers.length !== input.assignments.length) throw new IsolationError();
            const previous = await tx.botMcpServer.findMany({
              where: {
                botId: bot.id,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
              select: { serverId: true },
            });
            const nextIds = new Set(input.assignments.map((assignment) => assignment.serverId));
            const removed = previous
              .map((row) => row.serverId)
              .filter((serverId) => !nextIds.has(serverId));
            await tx.botMcpServer.deleteMany({
              where: {
                botId: bot.id,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
            });
            if (input.assignments.length)
              await tx.botMcpServer.createMany({
                data: input.assignments.map((assignment) => ({
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                  botId: bot.id,
                  serverId: assignment.serverId,
                  allowAllTools: assignment.allowAllTools,
                  allowedTools: assignment.allowedTools as Prisma.InputJsonValue,
                })),
              });
            const seqs = (
              await Promise.all(
                removed.map((serverId) =>
                  revertConnectedMcpApprovals(
                    onboardingDeps,
                    context.actor,
                    { botId: bot.id, serverId, status: "pending" },
                    tx,
                  ),
                ),
              )
            ).flat();
            const rows = await tx.botMcpServer.findMany({
              where: {
                botId: bot.id,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
              orderBy: { createdAt: "asc" },
            });
            return { rows, seqs };
          });
          for (const event of seqs) await deps.events.notify(event.threadId, event.seq);
          return rows.map(mcpAssignmentDto);
        }),
      },
      oauth: {
        begin: authed.mcp.oauth.begin.handler(async ({ context, input }) => {
          try {
            const expectedRedirect = new URL("/mcp/oauth/callback", deps.env.webOrigin).toString();
            if (new URL(input.redirectUri).toString() !== expectedRedirect) {
              throw new Error("MCP OAuth redirect URI is not allowed");
            }
            return await mcpOAuth.begin({
              ...input,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            });
          } catch (error) {
            throw new ORPCError("BAD_REQUEST", {
              message: error instanceof Error ? error.message : "Could not start MCP OAuth",
            });
          }
        }),
        complete: authed.mcp.oauth.complete.handler(async ({ context, input }) => {
          try {
            // complete() consumes the session, so which server it belongs to is read first.
            const session = deps.mcp
              ? await deps.prisma.mcpOAuthSession
                  .findFirst({
                    where: {
                      id: input.sessionId,
                      spaceId: context.actor.spaceId,
                      userId: context.actor.userId,
                    },
                    select: { serverId: true },
                  })
                  .catch(() => null)
              : null;
            await mcpOAuth.complete({
              ...input,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            });
            if (session) {
              // The account is connected now: check the server so it shows ok/error.
              void (async () => {
                const server = await deps.prisma.mcpServer.findFirst({
                  where: {
                    id: session.serverId,
                    spaceId: context.actor.spaceId,
                    userId: context.actor.userId,
                  },
                });
                if (server)
                  await beginMcpProbe(
                    server,
                    context.actor,
                    await mcpOAuth.summaryFor(server, context.actor),
                  );
              })().catch((error) =>
                getLogger().error("mcp server probe after oauth failed", error),
              );
            }
            return { ok: true as const };
          } catch (error) {
            throw new ORPCError("BAD_REQUEST", {
              message: error instanceof Error ? error.message : "Could not complete MCP OAuth",
            });
          }
        }),
        disconnect: authed.mcp.oauth.disconnect.handler(async ({ context, input }) => {
          await mcpOAuth.disconnect({
            ...input,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          });
          return { ok: true as const };
        }),
      },
    },
    onboarding: {
      signupSurvey: authed.onboarding.signupSurvey.handler(async ({ context, input }) => {
        const answers = {
          reason: input.reason || null,
          use: input.use ?? null,
          teamSize: signupSurveyAsksTeamSize(input.use) ? (input.teamSize ?? null) : null,
          source: input.source || null,
        };
        const saved = await deps.prisma.signupSurvey.upsert({
          where: { userId: context.actor.userId },
          create: { userId: context.actor.userId, ...answers },
          update: answers,
        });
        deps.analytics?.capture(
          context.actor.userId,
          {
            name: "signup_survey_answered",
            skipped: Object.values(answers).every((answer) => answer === null),
            ...(answers.use ? { use: answers.use } : {}),
            ...(answers.teamSize ? { teamSize: answers.teamSize } : {}),
          },
          // The first save's time keeps a resubmission a duplicate of the same event.
          { id: context.actor.userId, at: saved.createdAt },
        );
        return { ok: true as const };
      }),
      start: authed.onboarding.start.handler(async ({ context, input }) => {
        await startOnboarding(onboardingDeps, context.actor, input.botId);
        return { ok: true as const };
      }),
      promptFocus: authed.onboarding.promptFocus.handler(async ({ context, input }) => {
        await promptFocus(onboardingDeps, context.actor, input.botId);
        return { ok: true as const };
      }),
      choose: authed.onboarding.choose.handler(async ({ context, input }) => {
        await chooseFocus(onboardingDeps, context.actor, input.botId, input.optionId);
        return { ok: true as const };
      }),
      dismissFocus: authed.onboarding.dismissFocus.handler(async ({ context, input }) => {
        await dismissFocus(onboardingDeps, context.actor, input.botId);
        return { ok: true as const };
      }),
      appConnected: authed.onboarding.appConnected.handler(async ({ context, input }) => {
        await markAppConnected(
          onboardingDeps,
          context.actor,
          input.botId,
          input.provider,
          input.connectorId,
          input.threadId,
          input.messageId,
        );
        return { ok: true as const };
      }),
    },
    integrationSetup: {
      get: authed.integrationSetup.get.handler(() => ({
        canConfigure: false,
        needsSetup: false,
        webUrl: new URL("/integrations/setup", deps.env.webOrigin).toString(),
        providers: [],
      })),
      save: authed.integrationSetup.save.handler(() => {
        throw new ORPCError("FORBIDDEN");
      }),
    },
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
