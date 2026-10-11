import { resolveComposerSendPlan } from "@rakazo/core";
import { beforeEach, expect, it, vi } from "vitest";
import { outboxDisk } from "./outbox-disk";
import type { SendAttempt } from "./thread-feedback";
import { OUTBOX_MAX_ENTRIES } from "./thread-feedback";

const files = vi.hoisted(() => new Map<string, string>());
vi.mock("expo-file-system", () => {
  class Directory {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = parts.map((p) => (typeof p === "string" ? p : p.uri)).join("/");
    }
    get exists() {
      return [...files.keys()].some((p) => p.startsWith(this.uri));
    }
    create() {}
    delete() {
      files.clear();
    }
  }
  class File extends Directory {
    override get exists() {
      return files.has(this.uri);
    }
    textSync() {
      return files.get(this.uri);
    }
    write(text: string) {
      files.set(this.uri, text);
    }
  }
  return { Directory, File, Paths: { cache: "cache" } };
});
const scope = {
  apiBase: "https://api.example.test",
  userId: "user-a",
  cacheSession: "namespace-a",
  spaceId: "space-a",
};
function attempt(nonce = "nonce-a"): SendAttempt {
  return {
    ...scope,
    state: "pending",
    session: 1,
    clientNonce: nonce,
    artifactIds: new Map([["attachment-a", "artifact-a"]]),
    payload: {
      originThreadKey: "bot-a",
      displayText: "Hello",
      replyPreview: null,
      botTarget: "bot-a",
      reroutedToGroup: false,
      plan: resolveComposerSendPlan({ text: "Hello", mentions: [], hasAttachments: true }),
      replyQuote: null,
      attachments: [
        {
          id: "attachment-a",
          name: "photo.png",
          mimeType: "image/png",
          contentBase64: "aGVsbG8=",
          previewUri: "file:///fake-preview",
        },
      ],
    },
  };
}
beforeEach(() => files.clear());
it("restores payload, uploaded ids and nonce for an idempotent retry", () => {
  const original = attempt();
  outboxDisk.save([original]);
  const [restored] = outboxDisk.load(2, scope);
  expect(restored).toMatchObject({
    state: "queued",
    session: 2,
    clientNonce: original.clientNonce,
  });
  expect(restored?.artifactIds).toEqual(original.artifactIds);
  expect(restored?.payload.attachments[0]?.contentBase64).toBe("aGVsbG8=");
  expect([...files.values()][0]).not.toContain("file:");
});
it.each([
  { userId: "user-b" },
  { apiBase: "https://other.example.test" },
  { cacheSession: "namespace-b" },
])("rejects a different owner or session %j", (change) => {
  outboxDisk.save([attempt()]);
  expect(outboxDisk.load(2, { ...scope, ...change })).toEqual([]);
});
it("caps the persisted count and wipes every entry", () => {
  outboxDisk.save(Array.from({ length: OUTBOX_MAX_ENTRIES + 5 }, (_, i) => attempt(`nonce-${i}`)));
  expect(outboxDisk.load(2, scope)).toHaveLength(OUTBOX_MAX_ENTRIES);
  outboxDisk.clear();
  expect(files.size).toBe(0);
});
it("treats corrupt storage as an empty outbox", () => {
  files.set("cache/outbox/sends-v3.json", "{");
  expect(outboxDisk.load(2, scope)).toEqual([]);
});
