import { useSyncExternalStore } from "react";

export type ToastVariant = "error" | "info" | "success";

export type ToastOptions = {
  variant: ToastVariant;
  detail?: string;
  action?: { label: string; run: () => void };
  /** A toast with the same key replaces the shown or queued one instead of stacking. */
  dedupeKey?: string;
};

export type Toast = ToastOptions & { id: number; message: string };

export type ToastState = { toast: Toast; leaving: boolean } | null;

export const TOAST_DURATION_MS = 3200;
export const TOAST_ACTION_DURATION_MS = 6400;
export const TOAST_EXIT_MS = 220;

let nextId = 0;
let current: ToastState = null;
let queue: Toast[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let suspended = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function schedule(ms: number, run: () => void) {
  clearTimeout(timer);
  timer = setTimeout(run, ms);
}

function present(toast: Toast) {
  current = { toast, leaving: false };
  schedule(toast.action ? TOAST_ACTION_DURATION_MS : TOAST_DURATION_MS, leave);
  emit();
}

function advance() {
  const next = queue.shift();
  if (next) {
    present(next);
    return;
  }
  clearTimeout(timer);
  current = null;
  emit();
}

function leave() {
  if (!current || current.leaving) return;
  current = { ...current, leaving: true };
  schedule(TOAST_EXIT_MS, advance);
  emit();
}

/** One transient notice at a time, shown by the ToastHost mounted at the app root. */
export const toast = {
  show(message: string, options: ToastOptions) {
    if (suspended) return;
    const key = options.dedupeKey;
    if (key && current?.toast.dedupeKey === key) {
      present({ ...options, id: current.toast.id, message });
      return;
    }
    const next = { ...options, id: ++nextId, message };
    const queued = key ? queue.findIndex((item) => item.dedupeKey === key) : -1;
    if (queued >= 0) queue[queued] = next;
    else queue.push(next);
    if (!current) advance();
  },
  /** Dismisses the shown toast, or with a key only the toasts carrying it. */
  dismiss(dedupeKey?: string) {
    if (dedupeKey) queue = queue.filter((item) => item.dedupeKey !== dedupeKey);
    if (!dedupeKey || current?.toast.dedupeKey === dedupeKey) leave();
  },
  /** Drops the shown and queued toasts at once. */
  clear() {
    queue = [];
    clearTimeout(timer);
    if (!current) return;
    current = null;
    emit();
  },
  /**
   * From sign-out until the next sign-in: drops every toast and ignores new ones, so a request
   * of the old account that fails late can't show its notice on the sign-in screen.
   */
  suspend() {
    suspended = true;
    toast.clear();
  },
  resume() {
    suspended = false;
  },
};

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useToastState(): ToastState {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}

/** The card is one accessible element: "title. detail. action". */
export function toastAccessibilityLabel(toast: Toast): string {
  return [toast.message, toast.detail, toast.action?.label]
    .map((part) => part?.trim().replace(/[.!?。]+$/u, ""))
    .filter(Boolean)
    .join(". ");
}
