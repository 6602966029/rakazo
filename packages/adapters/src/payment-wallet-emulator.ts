import { createHash, randomUUID } from "node:crypto";
import type {
  AdapterContext,
  AdapterDescriptor,
  PaymentCardSecret,
  PaymentWalletCapabilities,
  PaymentWalletConnectResult,
  PaymentWalletConnectStart,
  PaymentWalletCredential,
  PaymentWalletProvider,
  PurchaseRequest,
  PurchaseSnapshot,
} from "@rakazo/adapter-kit";
import { PaymentWalletDisconnected, PaymentWalletRequestRejected } from "@rakazo/adapter-kit";

/** Purchases above this many minor units are denied, so callers can drive both outcomes. */
export const EMULATOR_DENY_ABOVE = 100_000;

/**
 * Deterministic offline wallet. Sign-in completes on the first poll. A purchase starts
 * pending and reads back approved (or denied above `EMULATOR_DENY_ABOVE`). State lives in
 * the ids and tokens, so an API and a worker process agree without sharing memory; only
 * revocation and the not-yet-read state are per process.
 */
export class EmulatorPaymentWalletProvider implements PaymentWalletProvider {
  readonly displayName = "Emulator Wallet";
  private readonly revoked = new Set<string>();
  private readonly unread = new Set<string>();

  describe(): AdapterDescriptor<PaymentWalletCapabilities> {
    return {
      id: "emulator",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { offline: true },
    };
  }

  async beginConnect(
    _request: { clientName: string },
    context: AdapterContext,
  ): Promise<PaymentWalletConnectStart> {
    context.signal.throwIfAborted();
    const code = randomUUID();
    return {
      state: code,
      verificationUrl: `https://wallet.emulator.invalid/connect/${code}`,
      userCode: "EMUL-ATOR",
      expiresAt: new Date(Date.now() + 15 * 60_000),
      intervalMs: 1000,
    };
  }

  async pollConnect(_state: string, context: AdapterContext): Promise<PaymentWalletConnectResult> {
    context.signal.throwIfAborted();
    return { status: "connected", credential: issue() };
  }

  async refresh(
    credential: PaymentWalletCredential,
    context: AdapterContext,
  ): Promise<PaymentWalletCredential> {
    this.check(credential, context);
    this.revoked.add(credential.secret);
    return issue();
  }

  async disconnect(credential: PaymentWalletCredential, context: AdapterContext): Promise<void> {
    context.signal.throwIfAborted();
    this.revoked.add(credential.secret);
  }

  async createPurchase(
    credential: PaymentWalletCredential,
    request: PurchaseRequest,
    context: AdapterContext,
  ): Promise<PurchaseSnapshot> {
    this.check(credential, context);
    const key = createHash("sha256").update(request.idempotencyKey).digest("hex").slice(0, 16);
    const id = `${PURCHASE_PREFIX}${request.amount}_${key}`;
    this.unread.add(id);
    return {
      id,
      status: "pending_approval",
      approvalUrl: `https://wallet.emulator.invalid/approve/${id}`,
    };
  }

  async getPurchase(
    credential: PaymentWalletCredential,
    id: string,
    context: AdapterContext,
  ): Promise<PurchaseSnapshot> {
    this.check(credential, context);
    const denied = amountOf(id) > EMULATOR_DENY_ABOVE;
    this.unread.delete(id);
    if (denied) return { id, status: "denied" };
    return {
      id,
      status: "approved",
      card: {
        brand: "visa",
        last4: "4242",
        expMonth: 12,
        expYear: 2034,
        billingAddress: { name: "Test User", line1: "1 Test Street", country: "US" },
      },
    };
  }

  async revealCard(
    credential: PaymentWalletCredential,
    id: string,
    context: AdapterContext,
  ): Promise<PaymentCardSecret> {
    this.check(credential, context);
    if (amountOf(id) > EMULATOR_DENY_ABOVE || this.unread.has(id)) {
      throw new PaymentWalletRequestRejected("The purchase is not approved.");
    }
    return { number: "4242424242424242", cvc: "123" };
  }

  private check(credential: PaymentWalletCredential, context: AdapterContext) {
    context.signal.throwIfAborted();
    if (!credential.secret.startsWith(TOKEN_PREFIX) || this.revoked.has(credential.secret)) {
      throw new PaymentWalletDisconnected();
    }
  }
}

const TOKEN_PREFIX = "emulator_token_";
const PURCHASE_PREFIX = "emulator_purchase_";

function issue(): PaymentWalletCredential {
  return {
    secret: `${TOKEN_PREFIX}${randomUUID()}`,
    refreshAt: new Date(Date.now() + 60 * 60_000),
  };
}

function amountOf(id: string): number {
  const match = /^emulator_purchase_(\d+)_[0-9a-f]{16}$/.exec(id);
  if (!match) throw new PaymentWalletRequestRejected("The purchase was not found.");
  return Number(match[1]);
}
