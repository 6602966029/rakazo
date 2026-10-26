import type { BillingStatus, Me } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { createContext, Suspense, useContext, useEffect, useState } from "react";
import { fetchAuthCapabilities } from "../lib/auth-capabilities";
import { peekInitialBootstrap } from "../lib/bootstrap";
import { lazyComponent } from "../lib/preload-recovery";
import { rpc } from "../lib/rpc";

const PaywallPage = lazyComponent(() =>
  import("../pages/Paywall").then((module) => module.PaywallPage),
);

type GateState =
  | { kind: "loading" }
  | { kind: "open"; status?: BillingStatus }
  | { kind: "paywall"; status: BillingStatus };

const BillingStatusContext = createContext<BillingStatus | null>(null);

/** The billing status the gate opened with; `null` when the deployment does not bill. */
export function useBillingStatus() {
  return useContext(BillingStatusContext);
}

function loadMe(): Promise<Me> {
  const primed = peekInitialBootstrap();
  if (!primed) return rpc.me();
  return primed.then(
    (bootstrap) => bootstrap.me,
    () => rpc.me(),
  );
}

function gateFor(status: BillingStatus): GateState {
  return { kind: status.access ? "open" : "paywall", status };
}

/**
 * Holds the app behind the paywall when the deployment bills. Self-hosted
 * installs only make the capabilities request. Enforcement belongs to the API,
 * so a failed lookup here falls through to the app.
 */
export function SubscriptionGate({
  children,
  fallback,
}: {
  children: ReactNode;
  fallback: ReactNode;
}) {
  const [state, setState] = useState<GateState>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    fetchAuthCapabilities()
      .then(async (capabilities): Promise<GateState> => {
        if (!capabilities.billing || !(await loadMe()).billingEnabled) return { kind: "open" };
        return gateFor(await rpc.billing.status());
      })
      .catch((): GateState => ({ kind: "open" }))
      .then((next) => {
        if (active) setState(next);
      });
    return () => {
      active = false;
    };
  }, []);

  const paywalled = state.kind === "paywall";
  useEffect(() => {
    if (!paywalled) return;
    // Checkout can finish in another window (the system browser on desktop).
    let active = true;
    const recheck = () => {
      if (document.visibilityState === "hidden") return;
      rpc.billing
        .status()
        .then((status) => {
          if (active) setState(gateFor(status));
        })
        .catch(() => undefined);
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      active = false;
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [paywalled]);

  if (state.kind === "loading") return fallback;
  if (state.kind === "paywall") {
    return (
      <Suspense fallback={fallback}>
        <PaywallPage status={state.status} />
      </Suspense>
    );
  }
  return (
    <BillingStatusContext.Provider value={state.status ?? null}>
      {children}
    </BillingStatusContext.Provider>
  );
}
