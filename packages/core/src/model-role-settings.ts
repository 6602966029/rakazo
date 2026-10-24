import type { ModelCatalogEntry, ModelRoleSettings } from "@rakazo/contracts";

export interface ModelRoleTransport {
  load(): Promise<ModelRoleSettings>;
  catalog(): Promise<ModelCatalogEntry[]>;
  save(patch: Partial<ModelRoleSettings>): Promise<ModelRoleSettings>;
}
export type ModelRoleState = {
  settings: ModelRoleSettings | null;
  catalog: ModelCatalogEntry[];
  busy: boolean;
  error: string | null;
};

type SaveQueue = { tail: Promise<void>; failures: number };
const pendingWrites = new Map<string, SaveQueue>();

/** Shared web/native lifecycle. Writes finish in their original scope; stale loads cannot win. */
export function createModelRoleSettings(transport: ModelRoleTransport, scopeKey: string) {
  let state: ModelRoleState = { settings: null, catalog: [], busy: true, error: null };
  let generation = 0;
  let confirmed: ModelRoleSettings | null = null;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<ModelRoleState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => state,
    async load() {
      const current = ++generation;
      publish({ busy: true, error: null });
      try {
        await pendingWrites.get(scopeKey)?.tail;
        const [settings, catalog] = await Promise.all([transport.load(), transport.catalog()]);
        if (current === generation) {
          confirmed = settings;
          publish({ settings, catalog, busy: false });
        }
      } catch (error) {
        if (current === generation)
          publish({
            busy: false,
            error: error instanceof Error ? error.message : "Could not load models",
          });
      }
    },
    async save(patch: Partial<ModelRoleSettings>) {
      if (state.busy || !state.settings) return;
      const current = generation;
      publish({ settings: { ...state.settings, ...patch }, error: null });
      const queue = pendingWrites.get(scopeKey) ?? { tail: Promise.resolve(), failures: 0 };
      const failures = queue.failures;
      const write = queue.tail.then(async () => {
        if (failures !== queue.failures) return;
        try {
          confirmed = await transport.save(patch);
        } catch (error) {
          queue.failures += 1;
          if (current === generation)
            publish({
              settings: confirmed,
              error: error instanceof Error ? error.message : "Could not save models",
            });
        }
      });
      queue.tail = write;
      pendingWrites.set(scopeKey, queue);
      await write;
      if (queue.tail === write) pendingWrites.delete(scopeKey);
    },
  };
}
