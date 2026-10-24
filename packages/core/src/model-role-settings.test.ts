import type { ModelRoleSettings } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { createModelRoleSettings } from "./model-role-settings.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const empty: ModelRoleSettings = { primary: null, backups: [] };
const saved: ModelRoleSettings = {
  primary: { provider: "openrouter", modelId: "typesafe/jev-1.14" },
  backups: [],
};
function setup(key = crypto.randomUUID()) {
  const transport = {
    load: vi.fn(async () => empty),
    catalog: vi.fn(async () => []),
    save: vi.fn(async () => saved),
  };
  return { transport, controller: createModelRoleSettings(transport, key), key };
}
describe("shared model role settings lifecycle", () => {
  it("prevents replacing unseen settings, allows retry, and preserves saved settings on failure", async () => {
    const { transport, controller } = setup();
    transport.load.mockRejectedValueOnce(new Error("offline"));
    await controller.load();
    await controller.save({ backups: [] });
    expect(transport.save).not.toHaveBeenCalled();
    await controller.load();
    transport.save.mockRejectedValueOnce(new Error("save failed"));
    await controller.save({ primary: saved.primary });
    expect(controller.snapshot()).toMatchObject({
      settings: empty,
      error: "save failed",
      busy: false,
    });
  });
  it("waits for an accepted write before reopening the same role and serializes edits", async () => {
    const { transport, controller, key } = setup();
    await controller.load();
    const write = deferred<ModelRoleSettings>();
    transport.save.mockReturnValueOnce(write.promise);
    const saving = controller.save({ primary: saved.primary });
    const secondSave = controller.save({ primary: null });
    const reopened = createModelRoleSettings(transport, key);
    transport.load.mockResolvedValue(saved);
    const loading = reopened.load();
    await Promise.resolve();
    expect(transport.load).toHaveBeenCalledTimes(1);
    write.resolve(saved);
    await Promise.all([saving, secondSave, loading]);
    expect(transport.save).toHaveBeenCalledTimes(2);
    expect(reopened.snapshot().settings).toEqual(saved);
  });
  it("does not block unrelated roles or scopes and ignores obsolete loads", async () => {
    const { transport, controller } = setup();
    const old = deferred<ModelRoleSettings>();
    transport.load.mockReturnValueOnce(old.promise).mockResolvedValueOnce(saved);
    const first = controller.load();
    await Promise.resolve();
    await controller.load();
    old.resolve(empty);
    await first;
    expect(controller.snapshot().settings).toEqual(saved);
    const other = setup();
    await other.controller.load();
    expect(other.controller.snapshot().settings).toEqual(empty);
  });
});
