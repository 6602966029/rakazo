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

const BillingContext = createContext<{ status: BillingStatus | null; showPlans: () => void }>({
  status: null,
  showPlans: () => undefined,
});

/** The latest billing status (`null` when the deployment does not bill) and the plan choice. */
export function useBilling() {
  return useContext(BillingContext);
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
  const [plansOpen, setPlansOpen] = useState(false);

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

  const billed = state.kind !== "loading" && state.status !== undefined;
  useEffect(() => {
    if (!billed) return;
    // Checkout can finish in another window (the system browser on desktop), and a free period
    // can end while the app is open.
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
  }, [billed]);

  if (state.kind === "loading") return fallback;
  if (state.kind === "paywall") {
    return (
      <Suspense fallback={fallback}>
        <PaywallPage status={state.status} />
      </Suspense>
    );
  }
  return (
    <BillingContext.Provider
      value={{ status: state.status ?? null, showPlans: () => setPlansOpen(true) }}
    >
      {children}
      {plansOpen && state.status ? (
        // Over the app rather than replacing it, so closing keeps its state.
        <div className="fixed inset-0 z-50 overflow-y-auto bg-background">
          <Suspense fallback={fallback}>
            <PaywallPage status={state.status} onClose={() => setPlansOpen(false)} />
          </Suspense>
        </div>
      ) : null}
    </BillingContext.Provider>
  );
}
