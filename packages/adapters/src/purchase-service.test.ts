import type { AdapterContext } from "@rakazo/adapter-kit";
import { PaymentWalletDisconnected, PaymentWalletRequestRejected } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakePaymentWallet, fakeJobs, fakePurchasePrisma } from "./fake-purchases.js";
import {
  executePurchaseTool,
  loadPurchaseCardRedactions,
  resolvePurchaseCardFill,
} from "./purchase-service.js";

vi.mock("./payment-wallets.js", () => ({
  withPaymentWalletCredential: async (
    _deps: unknown,
    _actor: unknown,
    fn: (credential: { secret: string; refreshAt: null }) => Promise<unknown>,
  ) => fn({ secret: "credential", refreshAt: null }),
}));

const fixture = { spaceId: "space-1", userId: "user-1", botId: "bot-1", threadId: "thread-1" };
const request = {
  merchantName: "Example Store",
  merchantUrl: "https://shop.example.test/checkout",
  amount: 1999,
  currency: "USD",
  reason: "Two boxes of printer paper for the office, as the user asked this morning. ".repeat(2),
};

function setup() {
  const db = fakePurchasePrisma(fixture);
  const queue = fakeJobs();
  const wallet = new FakePaymentWallet();
  const secrets = new Map<string, string>();
  const secretStore = {
    put: async (plaintext: string) => {
      const ref = `sealed-${secrets.size + 1}`;
      secrets.set(ref, plaintext);
      return { id: ref, ref, ciphertext: ref };
    },
    load: async (ref: string) => secrets.get(ref)!,
    delete: async (ref: string) => {
      secrets.delete(ref);
    },
  } as never;
  const deps = {
    prisma: db.prisma,
    secretStore,
    jobs: queue.jobs,
    paymentWallet: wallet,
  };
  const context = (operationId = "op-1"): AdapterContext & { botId: string } => ({
    operationId,
    traceId: operationId,
    spaceId: fixture.spaceId,
    userId: fixture.userId,
    botId: fixture.botId,
    signal: new AbortController().signal,
  });
  const call = (name: string, args: Record<string, unknown>, operationId?: string) =>
    executePurchaseTool(deps, context(operationId), { threadId: fixture.threadId }, name, args);
  return { ...db, ...queue, wallet, deps, call, secrets };
}

describe("request_purchase", () => {
  let env: ReturnType<typeof setup>;
  beforeEach(() => {
    env = setup();
  });

  it("asks the wallet owner, records the purchase and schedules a poll", async () => {
    const result = await env.call("request_purchase", request);
    expect(env.wallet.created).toEqual([
      expect.objectContaining({ amount: 1999, currency: "usd", idempotencyKey: "op-1" }),
    ]);
    expect(result).toMatchObject({
      id: "purchase-1",
      status: "pending_approval",
      merchantUrl: request.merchantUrl,
      amount: 1999,
      currency: "usd",
      approvalUrl: "https://wallet.example.test/approve/remote-op-1",
    });
    expect(env.purchases[0]).toMatchObject({
      operationKey: "op-1",
      remoteId: "remote-op-1",
      provider: "fake",
      wokenStatus: "pending_approval",
    });
    expect(env.purchases[0]!.nextPollAt).toBeInstanceOf(Date);
    expect(env.enqueued.map((job) => job.name)).toEqual(["purchase.poll"]);
  });

  it("returns the recorded purchase when the call replays", async () => {
    const first = await env.call("request_purchase", request);
    const second = await env.call("request_purchase", request);
    expect(second).toEqual(first);
    expect(env.wallet.created).toHaveLength(1);
    expect(env.purchases).toHaveLength(1);
  });

  it("rejects invalid input before reaching the wallet", async () => {
    const result = await env.call("request_purchase", {
      ...request,
      merchantUrl: "http://shop.example.test",
      reason: "too short",
    });
    expect(result).toMatchObject({ error: expect.stringContaining("merchantUrl") });
    expect(env.wallet.created).toHaveLength(0);
  });

  it("tells the bot to have the user connect the wallet when it is disconnected", async () => {
    env.wallet.createPurchase = async () => {
      throw new PaymentWalletDisconnected();
    };
    const result = await env.call("request_purchase", request);
    expect(result).toEqual({ error: expect.stringContaining("Settings") });
    expect(env.purchases).toHaveLength(0);
  });

  it("passes the provider's safe rejection message through", async () => {
    env.wallet.createPurchase = async () => {
      throw new PaymentWalletRequestRejected("The amount is over the wallet's limit.");
    };
    expect(await env.call("request_purchase", request)).toEqual({
      error: "The amount is over the wallet's limit.",
    });
  });

  it("is unavailable without a wallet", async () => {
    const result = await executePurchaseTool(
      { ...env.deps, paymentWallet: null },
      {
        operationId: "op",
        traceId: "op",
        spaceId: fixture.spaceId,
        userId: fixture.userId,
        botId: fixture.botId,
        signal: new AbortController().signal,
      },
      { threadId: fixture.threadId },
      "request_purchase",
      request,
    );
    expect(result).toHaveProperty("error");
  });
});

describe("purchase_status", () => {
  it("shows the card summary once approved and never the number or code", async () => {
    const env = setup();
    await env.call("request_purchase", request);
    env.wallet.snapshots.set("remote-op-1", {
      id: "remote-op-1",
      status: "approved",
      card: { brand: "visa", last4: "4242", expMonth: 12, expYear: 2034 },
    });
    const result = await env.call("purchase_status", { id: "purchase-1" });
    expect(result).toMatchObject({
      status: "approved",
      card: { brand: "visa", last4: "4242", expMonth: 12, expYear: 2034 },
      next: expect.stringContaining("fill_card"),
    });
    expect(JSON.stringify(result)).not.toContain("4242424242424242");
    // The bot saw this status itself, so the poller does not wake it for it again.
    expect(env.purchases[0]).toMatchObject({
      status: "approved",
      wokenStatus: "approved",
      nextPollAt: null,
    });
  });

  it("only finds this user's purchases in this space", async () => {
    const env = setup();
    await env.call("request_purchase", request);
    env.purchases[0]!.userId = "someone-else";
    expect(await env.call("purchase_status", { id: "purchase-1" })).toEqual({
      error: "Unknown purchase.",
    });
  });
});

describe("resolvePurchaseCardFill", () => {
  it("returns the value, its merchant origin and the number to redact", async () => {
    const env = setup();
    await env.call("request_purchase", request);
    const scope = { spaceId: fixture.spaceId, userId: fixture.userId, botId: fixture.botId };
    expect(await resolvePurchaseCardFill(env.deps, scope, "purchase-1", "number")).toEqual({
      error: expect.stringContaining("not approved"),
    });
    env.purchases[0]!.status = "approved";
    const number = await resolvePurchaseCardFill(env.deps, scope, "purchase-1", "number");
    expect(number).toEqual({
      text: "4242424242424242",
      origin: "https://shop.example.test",
      redactions: ["4242424242424242", "4242 4242 4242 4242"],
    });
    expect(await resolvePurchaseCardFill(env.deps, scope, "purchase-1", "cvc")).toMatchObject({
      text: "123",
      origin: "https://shop.example.test",
    });
    expect(
      await resolvePurchaseCardFill(
        env.deps,
        { ...scope, userId: "someone-else" },
        "purchase-1",
        "cvc",
      ),
    ).toEqual({ error: "Unknown purchase." });
    // Another bot of the same user can't type it: its runs would not keep hiding the card.
    expect(
      await resolvePurchaseCardFill(env.deps, { ...scope, botId: "bot-2" }, "purchase-1", "cvc"),
    ).toEqual({ error: "Unknown purchase." });
  });

  it("keeps hiding a typed card in the bot's later runs, sealed at rest", async () => {
    const env = setup();
    await env.call("request_purchase", request);
    const run = { spaceId: fixture.spaceId, userId: fixture.userId, botId: fixture.botId };
    expect(await loadPurchaseCardRedactions(env.deps, run)).toEqual([]);
    env.purchases[0]!.status = "approved";
    await resolvePurchaseCardFill(env.deps, run, "purchase-1", "number");
    await resolvePurchaseCardFill(env.deps, run, "purchase-1", "cvc");
    expect(env.purchases[0]!.cardCiphertext).toBe("sealed-1");
    expect(env.secrets.size).toBe(1);
    expect(await loadPurchaseCardRedactions(env.deps, run)).toEqual([
      "4242424242424242",
      "4242 4242 4242 4242",
    ]);
    expect(await loadPurchaseCardRedactions(env.deps, { ...run, botId: "bot-2" })).toEqual([]);
  });

  it("deletes a sealed card that two first fills raced to save", async () => {
    const env = setup();
    await env.call("request_purchase", request);
    env.purchases[0]!.status = "approved";
    const run = { spaceId: fixture.spaceId, userId: fixture.userId, botId: fixture.botId };
    await Promise.all([
      resolvePurchaseCardFill(env.deps, run, "purchase-1", "number"),
      resolvePurchaseCardFill(env.deps, run, "purchase-1", "cvc"),
    ]);
    expect(env.secrets.size).toBe(1);
    expect(env.secrets.has(env.purchases[0]!.cardCiphertext!)).toBe(true);
  });
});
