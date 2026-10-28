import { ORPCError } from "@orpc/server";
import type { TransactionalEmail, TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { parsePluginSource, previewPluginInstall } from "@rakazo/adapters";
import {
  pluginSubmissionAdminEmail,
  pluginSubmissionReceivedEmail,
  pluginSubmissionReviewedEmail,
} from "@rakazo/auth";
import type {
  PluginMarketplaceEntry,
  PluginSubmission,
  PluginSubmissionReview,
  PluginSubmissionStatus,
} from "@rakazo/contracts";
import { PLUGIN_SUBMISSIONS_PATH, PluginSubmissionInputSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import type { Context } from "hono";
import { Hono } from "hono";
import { readBoundedBody } from "./http-body.js";
import { assertMcpRemoteEndpoint } from "./mcp-servers.js";
import type { RouterDeps } from "./router.js";
import { windowCounter } from "./window-counter.js";

export const PLUGIN_REGISTRY = "Rakazo";
const MAX_BODY_BYTES = 32 * 1024;
const HOUR_MS = 60 * 60_000;
const SUBMISSIONS_PER_IP_PER_HOUR = 10;
// Anyone can type any address, so one inbox gets at most a few confirmations a day.
const CONFIRMATIONS_PER_EMAIL_PER_DAY = 3;

type SubmissionRow = Awaited<ReturnType<PrismaClient["pluginSubmission"]["findFirstOrThrow"]>>;

/** Delivery never holds up the request; the provider tracks it so shutdown drains it. */
function sendLater(
  email: TransactionalEmailProvider | undefined,
  message: Promise<TransactionalEmail>,
  onError: (error: unknown) => void,
): void {
  if (email) void message.then((built) => email.send(built)).catch(onError);
}

export async function isAdmin(
  prisma: PrismaClient,
  adminEmails: readonly string[],
  userId: string,
): Promise<boolean> {
  if (adminEmails.length === 0) return false;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });
  return Boolean(user?.emailVerified && adminEmails.includes(user.email.toLowerCase()));
}

export function pluginSubmissionDto(row: SubmissionRow): PluginSubmission {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    website: row.website,
    logo: row.logo,
    source: browseUrl(row.source),
    description: row.description,
    testing: row.testing,
    status: row.status as PluginSubmissionStatus,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
  };
}

/** The GitHub page for a stored source, opening the branch and folder it names. */
function browseUrl(source: string): string {
  const ref = parsePluginSource(source);
  return ref.ref || ref.subdir
    ? `${ref.gitUrl}/tree/${ref.ref ?? "HEAD"}${ref.subdir ? `/${ref.subdir}` : ""}`
    : ref.gitUrl;
}

/** The submitted repository in the form previews read, keeping the branch or commit it named. */
function submittedSource(source: string): string {
  const ref = parsePluginSource(source);
  if (new URL(ref.gitUrl).hostname !== "github.com")
    throw new Error("Use a public GitHub repository");
  return ref.gitUrl + (ref.ref ? `@${ref.ref}` : "") + (ref.subdir ? `#${ref.subdir}` : "");
}

/** The source installs are saved under: the repository and folder, without a ref. */
function installedSource(source: string): string {
  const ref = parsePluginSource(source);
  return ref.gitUrl + (ref.subdir ? `#${ref.subdir}` : "");
}

export function pluginSubmissionRoutes(deps: {
  prisma: PrismaClient;
  email?: TransactionalEmailProvider;
  adminEmails: readonly string[];
  webOrigin: string;
  clientIp: (c: Context) => string | undefined;
  onEmailError: (error: unknown) => void;
  now?: () => number;
}) {
  const app = new Hono();
  const submissions = windowCounter(HOUR_MS, deps.now);
  const confirmations = windowCounter(24 * HOUR_MS, deps.now);
  const send = (message: Promise<TransactionalEmail>) =>
    sendLater(deps.email, message, deps.onEmailError);

  app.post(PLUGIN_SUBMISSIONS_PATH, async (c) => {
    if (submissions(`ip:${deps.clientIp(c) ?? "unknown"}`) > SUBMISSIONS_PER_IP_PER_HOUR) {
      return c.json({ error: "Too many submissions. Try again later." }, 429, {
        "retry-after": String(HOUR_MS / 1000),
      });
    }
    const text = await readBoundedBody(c.req.raw, MAX_BODY_BYTES);
    if (text === null) return c.json({ error: "Submission is too large" }, 413);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return c.json({ error: "Send the submission as JSON" }, 400);
    }
    const parsed = PluginSubmissionInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid submission",
          issues: parsed.error.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
          })),
        },
        400,
      );
    }
    const { tested: _tested, ...input } = parsed.data;
    let source: string;
    try {
      source = submittedSource(input.source);
    } catch (error) {
      return c.json(
        {
          error: "Invalid submission",
          issues: [{ field: "source", message: (error as Error).message }],
        },
        400,
      );
    }
    const email = input.email.toLowerCase();
    const data = { ...input, email, source, website: input.website ?? null };
    // The same author resubmitting while it waits updates theirs; anyone else's is kept apart.
    const pending = await deps.prisma.pluginSubmission.findFirst({
      where: { source, email, status: "pending" },
      select: { id: true },
    });
    const row = pending
      ? await deps.prisma.pluginSubmission.update({ where: { id: pending.id }, data })
      : await deps.prisma.pluginSubmission.create({ data });
    const created = !pending;
    if (confirmations(row.email.toLowerCase()) <= CONFIRMATIONS_PER_EMAIL_PER_DAY) {
      send(pluginSubmissionReceivedEmail(row.email));
    }
    if (created) {
      const reviewUrl = new URL("/admin/plugins", deps.webOrigin).href;
      for (const admin of deps.adminEmails) {
        send(pluginSubmissionAdminEmail(admin, row, reviewUrl));
      }
    }
    return c.json({ id: row.id, status: row.status }, created ? 201 : 200);
  });

  return app;
}

export function listPluginSubmissions(prisma: PrismaClient, status: PluginSubmissionStatus) {
  return prisma.pluginSubmission
    .findMany({
      where: { status },
      orderBy: { createdAt: status === "pending" ? "asc" : "desc" },
      take: 200,
    })
    .then((rows) => rows.map(pluginSubmissionDto));
}

export async function reviewPluginSubmission(
  deps: Pick<RouterDeps, "prisma" | "pluginRepoFetcher" | "remoteConnectors" | "env"> & {
    email?: TransactionalEmailProvider;
    onEmailError: (error: unknown) => void;
  },
  reviewerId: string,
  input: PluginSubmissionReview,
  signal?: AbortSignal,
): Promise<PluginSubmission> {
  const row = await deps.prisma.pluginSubmission.findUnique({ where: { id: input.id } });
  if (!row) throw new ORPCError("NOT_FOUND", { message: "Submission not found" });
  if (row.status !== "pending") throw new ORPCError("CONFLICT", { message: "Already reviewed" });
  let listing = {};
  if (input.decision === "approve") {
    // Approval lists the commit that was checked, the same way the other registries pin theirs.
    const preview = await previewPluginInstall({
      source: row.source,
      signal,
      fetcher: deps.pluginRepoFetcher,
    }).catch(() => {
      throw new ORPCError("BAD_REQUEST", {
        message: "Could not preview a supported plugin from this repository",
      });
    });
    for (const server of preview.mcpServers) await assertMcpRemoteEndpoint(server.endpoint, deps);
    if (preview.skipped.some((part) => part.kind !== "unsupported_field")) {
      throw new ORPCError("BAD_REQUEST", { message: "This plugin would only install in part" });
    }
    if (!preview.skills.length && !preview.mcpServers.length) {
      throw new ORPCError("BAD_REQUEST", { message: "This plugin has no skills or MCP servers" });
    }
    const subdir = preview.source.subdir ? `#${preview.source.subdir}` : "";
    listing = {
      pinnedSource: `${preview.source.gitUrl}@${preview.resolvedSha}${subdir}`,
      hasConnector: preview.mcpServers.length > 0,
      skillCount: preview.skills.length,
    };
  }
  // Another admin may have decided while the preview ran; only one decision lands and is emailed.
  const decided = await deps.prisma.pluginSubmission.updateMany({
    where: { id: row.id, status: "pending" },
    data: {
      ...listing,
      status: input.decision === "approve" ? "approved" : "rejected",
      reason: input.decision === "reject" ? input.reason : null,
      reviewedAt: new Date(),
      reviewedByUserId: reviewerId,
    },
  });
  if (decided.count === 0) throw new ORPCError("CONFLICT", { message: "Already reviewed" });
  const updated = await deps.prisma.pluginSubmission.findUniqueOrThrow({ where: { id: row.id } });
  sendLater(
    deps.email,
    pluginSubmissionReviewedEmail({
      email: updated.email,
      name: updated.name,
      status: updated.status as "approved" | "rejected",
      reason: updated.reason,
    }),
    deps.onEmailError,
  );
  return pluginSubmissionDto(updated);
}

/** Approved submissions, newest approval per repository, as marketplace entries. */
export async function approvedPluginEntries(
  prisma: PrismaClient,
): Promise<PluginMarketplaceEntry[]> {
  const rows = await prisma.pluginSubmission.findMany({
    where: { status: "approved", pinnedSource: { not: null } },
    orderBy: { reviewedAt: "desc" },
  });
  const listed = new Set<string>();
  return rows.flatMap((row) => {
    const installed = installedSource(row.pinnedSource!);
    if (listed.has(installed)) return [];
    listed.add(installed);
    return [
      {
        id: `${PLUGIN_REGISTRY}:${row.pinnedSource}`,
        name: row.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, ""),
        displayName: row.name,
        description: row.description,
        keywords: [],
        category: null,
        logo: row.logo,
        homepage: row.website,
        domains: [],
        registry: PLUGIN_REGISTRY,
        source: row.pinnedSource!,
        installedSource: installed,
        hasConnector: row.hasConnector,
        skillCount: row.skillCount,
      },
    ];
  });
}
