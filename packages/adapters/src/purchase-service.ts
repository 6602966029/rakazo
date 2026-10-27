import type {
  AdapterContext,
  JobPublisher,
  PaymentWalletProvider,
  PurchaseCardSummary,
  PurchaseSnapshot,
  PurchaseStatus,
} from "@rakazo/adapter-kit";
import {
  PaymentWalletDisconnected,
  PaymentWalletRequestRejected,
  purchasePollJob,
} from "@rakazo/adapter-kit";
import type { PurchaseCardField } from "@rakazo/contracts";
import { PurchaseIdInput, PurchaseRequestInput } from "@rakazo/contracts";
import type { Purchase } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { PaymentWalletDeps } from "./payment-wallets.js";
import { withPaymentWalletCredential } from "./payment-wallets.js";
import { deleteSecretBestEffort } from "./secret-store-factory.js";

export type PurchaseDeps = Omit<PaymentWalletDeps, "paymentWallet"> & {
  jobs: JobPublisher;
  paymentWallet?: PaymentWalletProvider | null;
};

/** Statuses that still wait on the wallet owner, so the worker keeps polling. */
export const PENDING_PURCHASE_STATUSES: ReadonlySet<string> = new Set<PurchaseStatus>([
  "pending_approval",
  "needs_action",
]);
export const PURCHASE_POLL_MS = 5_000;

const NOT_CONFIGURED = { error: "No wallet is available." };
const DISCONNECTED = {
  error: "The user's wallet is not connected. Ask them to connect it in Settings, then try again.",
};

const NEXT: Record<string, string> = {
  pending_approval:
    "Tell the user to approve it in their wallet, then end your turn. You are woken when they decide.",
  needs_action:
    "The user must finish a step in their wallet at approvalUrl. You are woken when it changes.",
  approved:
    'Type the card on merchantUrl with browser_act fill_card (field "number", then "cvc"), passing this purchase id. Type the expiry and billing details yourself.',
  denied: "The user declined. Do not retry unless they ask.",
  expired: "The approval request expired. Ask the user before requesting again.",
  canceled: "The purchase was canceled.",
  failed: "The purchase failed.",
  completed: "The purchase is complete.",
};

function purchaseView(purchase: Purchase, card?: PurchaseCardSummary) {
  const status = purchase.status;
  return {
    id: purchase.id,
    status,
    merchantName: purchase.merchantName,
    merchantUrl: purchase.merchantUrl,
    amount: purchase.amount,
    currency: purchase.currency,
    ...(purchase.approvalUrl && PENDING_PURCHASE_STATUSES.has(status)
      ? { approvalUrl: purchase.approvalUrl }
      : {}),
    // Only the safe summary: the number and security code never reach the model.
    ...(card && status === "approved"
      ? {
          card: {
            brand: card.brand,
            last4: card.last4,
            expMonth: card.expMonth,
            expYear: card.expYear,
            ...(card.billingAddress ? { billingAddress: card.billingAddress } : {}),
          },
        }
      : {}),
    next:
      status === "approved" && !card ? "Call purchase_status for the card details." : NEXT[status],
  };
}

function providerError(error: unknown) {
  if (error instanceof PaymentWalletDisconnected) return DISCONNECTED;
  if (error instanceof PaymentWalletRequestRejected) return { error: error.message };
  throw error;
}

function walletDeps(deps: PurchaseDeps, provider: PaymentWalletProvider): PaymentWalletDeps {
  return { prisma: deps.prisma, secretStore: deps.secretStore, paymentWallet: provider };
}

/** Load a purchase's live status from the wallet, failing like the provider does. */
export async function fetchPurchase(
  deps: PurchaseDeps,
  provider: PaymentWalletProvider,
  purchase: Purchase,
  context: AdapterContext,
): Promise<PurchaseSnapshot> {
  return withPaymentWalletCredential(
    walletDeps(deps, provider),
    { userId: purchase.userId, spaceId: purchase.spaceId },
    (credential) => provider.getPurchase(credential, purchase.remoteId, context),
  );
}

/** request_purchase and purchase_status. Results never carry the card number or security code. */
export async function executePurchaseTool(
  deps: PurchaseDeps,
  context: AdapterContext & { botId: string },
  run: { threadId: string },
  name: string,
  args: Record<string, unknown>,
) {
  const provider = deps.paymentWallet;
  if (!provider) return NOT_CONFIGURED;
  if (name === "request_purchase") return requestPurchase(deps, provider, context, run, args);
  const parsed = PurchaseIdInput.safeParse(args);
  if (!parsed.success) return { error: "A purchase id is required." };
  const purchase = await deps.prisma.purchase.findFirst({
    where: {
      id: parsed.data.id,
      spaceId: context.spaceId,
      userId: context.userId,
      botId: context.botId,
    },
  });
  if (!purchase) return { error: "Unknown purchase." };
  if (!PENDING_PURCHASE_STATUSES.has(purchase.status) && purchase.status !== "approved")
    return purchaseView(purchase);
  let snapshot: PurchaseSnapshot;
  try {
    snapshot = await fetchPurchase(deps, provider, purchase, context);
  } catch (error) {
    return providerError(error);
  }
  return purchaseView(await recordSeenStatus(deps, purchase, snapshot), snapshot.card);
}

async function requestPurchase(
  deps: PurchaseDeps,
  provider: PaymentWalletProvider,
  context: AdapterContext & { botId: string },
  run: { threadId: string },
  args: Record<string, unknown>,
) {
  const parsed = PurchaseRequestInput.safeParse(args);
  if (!parsed.success) {
    return {
      error: parsed.error.issues
        .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ` : "") + issue.message)
        .join("; "),
    };
  }
  const request = parsed.data;
  const existing = await deps.prisma.purchase.findUnique({
    where: { operationKey: context.operationId },
  });
  if (existing) return purchaseView(ownedReplay(existing, context));
  let snapshot: PurchaseSnapshot;
  try {
    // The idempotency key makes a replay after a crash reuse the same remote purchase.
    snapshot = await withPaymentWalletCredential(
      walletDeps(deps, provider),
      { userId: context.userId, spaceId: context.spaceId },
      (credential) =>
        provider.createPurchase(
          credential,
          { ...request, idempotencyKey: context.operationId },
          context,
        ),
    );
  } catch (error) {
    return providerError(error);
  }
  const pending = PENDING_PURCHASE_STATUSES.has(snapshot.status);
  const thread = await deps.prisma.thread.findUniqueOrThrow({
    where: { id: run.threadId },
    select: { historyCompactionGeneration: true },
  });
  const purchase = ownedReplay(
    await deps.prisma.purchase.upsert({
      where: { operationKey: context.operationId },
      update: {},
      create: {
        operationKey: context.operationId,
        spaceId: context.spaceId,
        userId: context.userId,
        botId: context.botId,
        threadId: run.threadId,
        threadGeneration: thread.historyCompactionGeneration,
        provider: provider.describe().id,
        remoteId: snapshot.id,
        merchantName: request.merchantName,
        merchantUrl: request.merchantUrl,
        amount: request.amount,
        currency: request.currency,
        status: snapshot.status,
        approvalUrl: snapshot.approvalUrl ?? null,
        nextPollAt: pending ? new Date(Date.now() + PURCHASE_POLL_MS) : null,
        // The bot learns this status from the result; only later changes wake it.
        wokenStatus: snapshot.status,
      },
    }),
    context,
  );
  if (purchase.nextPollAt) await enqueuePurchasePoll(deps, purchase.id, purchase.nextPollAt);
  return purchaseView(purchase, snapshot.card);
}

function ownedReplay(purchase: Purchase, context: AdapterContext) {
  if (purchase.spaceId !== context.spaceId || purchase.userId !== context.userId)
    throw new Error("Purchase operation scope changed");
  return purchase;
}

/**
 * Save a status the bot just saw. It already knows it, so the poller does not wake it for
 * the same status. The updatedAt fence leaves a concurrent poll's newer write in place.
 */
async function recordSeenStatus(
  deps: PurchaseDeps,
  purchase: Purchase,
  snapshot: PurchaseSnapshot,
) {
  if (snapshot.status === purchase.status) return purchase;
  const pending = PENDING_PURCHASE_STATUSES.has(snapshot.status);
  const data = {
    status: snapshot.status,
    approvalUrl: snapshot.approvalUrl ?? purchase.approvalUrl,
    wokenStatus: snapshot.status,
    nextPollAt: pending ? (purchase.nextPollAt ?? new Date()) : null,
  };
  const saved = await deps.prisma.purchase.updateMany({
    where: { id: purchase.id, updatedAt: purchase.updatedAt },
    data,
  });
  if (saved.count && data.nextPollAt) await enqueuePurchasePoll(deps, purchase.id, data.nextPollAt);
  return { ...purchase, ...data };
}

/** The row is the outbox; a queue failure leaves it due for reconcilePurchases. */
export async function enqueuePurchasePoll(
  deps: Pick<PurchaseDeps, "jobs">,
  purchaseId: string,
  availableAt?: Date,
) {
  await deps.jobs.enqueue(purchasePollJob(purchaseId, availableAt)).catch(() => {
    getLogger().warn("purchase poll deferred to reconciliation");
  });
}

/**
 * The single-use card value browser_act fill_card types. Only the page fill path holds it;
 * `redactions` keep the number out of anything the run records afterwards.
 */
export async function resolvePurchaseCardFill(
  deps: Omit<PurchaseDeps, "jobs">,
  run: { spaceId: string; userId: string; botId: string },
  purchaseId: string,
  field: PurchaseCardField,
): Promise<{ text: string; origin: string; redactions: string[] } | { error: string }> {
  const provider = deps.paymentWallet;
  if (!provider) return NOT_CONFIGURED;
  const purchase = await deps.prisma.purchase.findFirst({
    // Only the bot that asked for it: its later runs are the ones that keep hiding the card.
    where: { id: purchaseId, spaceId: run.spaceId, userId: run.userId, botId: run.botId },
  });
  if (!purchase) return { error: "Unknown purchase." };
  if (purchase.status !== "approved")
    return { error: "The purchase is not approved. Check purchase_status." };
  const context: AdapterContext = {
    operationId: `purchase.card:${purchase.id}`,
    traceId: purchase.id,
    spaceId: purchase.spaceId,
    userId: purchase.userId,
    botId: purchase.botId,
    signal: AbortSignal.timeout(30_000),
  };
  let secret: Awaited<ReturnType<PaymentWalletProvider["revealCard"]>>;
  try {
    secret = await withPaymentWalletCredential(
      { prisma: deps.prisma, secretStore: deps.secretStore, paymentWallet: provider },
      { userId: purchase.userId, spaceId: purchase.spaceId },
      (credential) => provider.revealCard(credential, purchase.remoteId, context),
    );
  } catch (error) {
    return providerError(error);
  }
  const text = field === "number" ? secret.number : secret.cvc;
  if (!text) return { error: "This card has no security code." };
  // The page keeps the card after this run, so later runs on this bot hide it too.
  if (!purchase.cardCiphertext) {
    const recordId = `purchase-card:${purchase.id}`;
    const stored = await deps.secretStore.put(secret.number, context, { recordId });
    // A concurrent first fill or a failed write leaves this copy unreferenced, so it goes.
    const saved = await deps.prisma.purchase
      .updateMany({
        where: { id: purchase.id, cardCiphertext: null },
        data: { cardCiphertext: stored.ciphertext },
      })
      .catch(() => ({ count: 0 }));
    if (!saved.count)
      await deleteSecretBestEffort(deps.secretStore, stored.ciphertext, { recordId });
  }
  return {
    text,
    origin: new URL(purchase.merchantUrl).origin,
    redactions: cardRedactionForms(secret.number),
  };
}

/** A card number as pages show it: as given, digits only, and in groups of four. */
function cardRedactionForms(number: string): string[] {
  const digits = number.replace(/\D/g, "");
  const grouped = digits.replace(/(\d{4})(?=\d)/g, "$1 ");
  return [...new Set([number, digits, grouped].filter(Boolean))];
}

/** Single-use cards stop working well within this, and with them the reason to hide one. */
const CARD_REDACTION_WINDOW_MS = 7 * 24 * 60 * 60_000;

/**
 * Redaction forms of every card this bot typed recently. A checkout can keep or copy the number
 * after the filling run, so each run hides them before any tool output reaches the model.
 */
export async function loadPurchaseCardRedactions(
  deps: Pick<PurchaseDeps, "prisma" | "secretStore">,
  run: { spaceId: string; userId: string; botId: string },
): Promise<string[]> {
  const rows = await deps.prisma.purchase.findMany({
    where: {
      spaceId: run.spaceId,
      userId: run.userId,
      botId: run.botId,
      cardCiphertext: { not: null },
      createdAt: { gte: new Date(Date.now() - CARD_REDACTION_WINDOW_MS) },
    },
    select: { id: true, cardCiphertext: true },
  });
  const forms = new Set<string>();
  for (const row of rows) {
    try {
      const number = await deps.secretStore.load(row.cardCiphertext!, {
        recordId: `purchase-card:${row.id}`,
      });
      for (const form of cardRedactionForms(number)) forms.add(form);
    } catch {
      getLogger().warn("purchase card redaction could not be loaded");
    }
  }
  return [...forms];
}
