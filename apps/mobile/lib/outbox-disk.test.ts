import { resolveComposerSendPlan } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SendAttempt } from "./thread-feedback";

const fs = vi.hoisted(() => ({
  files: new Map<string, string>(),
  directories: new Set<string>(),
}));

vi.mock("expo-file-system", () => {
  const join = (parts: Array<string | { uri: string }>) =>
    parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
  class Directory {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = join(parts);
    }
    get name() {
      return this.uri.split("/").at(-1)!;
    }
    get exists() {
      return fs.directories.has(this.uri);
    }
    create() {
      fs.directories.add(this.uri);
    }
    delete() {
      for (const path of [...fs.files.keys()]) {
        if (path.startsWith(`${this.uri}/`)) fs.files.delete(path);
      }
      for (const path of [...fs.directories]) {
        if (path === this.uri || path.startsWith(`${this.uri}/`)) fs.directories.delete(path);
      }
    }
    list() {
      const children = new Set<string>();
      for (const path of [...fs.directories, ...fs.files.keys()]) {
        if (!path.startsWith(`${this.uri}/`)) continue;
        children.add(path.slice(this.uri.length + 1).split("/")[0]!);
      }
      return [...children].map((child) => {
        const uri = `${this.uri}/${child}`;
        return fs.directories.has(uri) ? new Directory(uri) : new File(uri);
      });
    }
  }
  class File {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = join(parts);
    }
    get exists() {
      return fs.files.has(this.uri);
    }
    get size() {
      return Math.floor(((fs.files.get(this.uri) ?? "").length * 3) / 4);
    }
    create() {
      fs.files.set(this.uri, "");
    }
    write(content: string) {
      fs.files.set(this.uri, content);
    }
    textSync() {
      return fs.files.get(this.uri)!;
    }
    async base64() {
      return fs.files.get(this.uri)!;
    }
    moveSync(destination: { uri: string }) {
      fs.files.set(destination.uri, fs.files.get(this.uri)!);
      fs.files.delete(this.uri);
    }
    delete() {
      fs.files.delete(this.uri);
    }
  }
  return { Directory, File, Paths: { cache: "cache" } };
});

const { OUTBOX_MAX_BYTES, OUTBOX_MAX_ENTRIES, outboxDisk } = await import("./outbox-disk");

function attempt(nonce: string, contentBase64 = "aGVsbG8="): SendAttempt {
  return {
    payload: {
      originThreadKey: "bot-1",
      composer: {
        draft: "Hello",
        mentions: [{ kind: "bot", id: "bot-2", name: "Scout" }],
        skill: null,
      },
      displayText: "@Scout Hello",
      replyPreview: null,
      initialBotTarget: "bot-1",
      botTarget: "bot-1",
      reroutedToGroup: false,
      plan: resolveComposerSendPlan({ text: "Hello", mentions: [], hasAttachments: true }),
      attachments: [
        {
          id: "photo.png-5-0",
          name: "photo.png",
          mimeType: "image/png",
          contentBase64,
          previewUri: "cache/ImagePicker/photo.png",
        },
      ],
      replyTargetId: "reply-1",
      replyQuote: null,
    },
    clientNonce: nonce,
    artifactIds: new Map(),
    state: "queued",
    heldOffline: true,
    createdAt: Date.UTC(2026, 9, 11, 12, 4),
    session: 0,
    apiBase: "https://rakazo.example",
    spaceId: "space-1",
  };
}

describe("outbox on disk", () => {
  beforeEach(() => {
    outboxDisk.clear();
    fs.files.clear();
    fs.directories.clear();
  });

  it("round-trips held messages with their attachments, without keeping content in the list", async () => {
    const held = attempt("nonce-1");
    const refused = { ...attempt("nonce-2"), state: "refused" as const, error: "Bot is archived" };
    const failed = { ...attempt("nonce-3"), state: "failed" as const };
    failed.artifactIds.set("photo.png-5-0", "artifact-1");
    for (const entry of [held, refused, failed]) expect(outboxDisk.admit(entry)).toBe(true);
    outboxDisk.save([held, refused, failed]);
    const list = fs.files.get("cache/outbox/outbox.json")!;
    expect(list).not.toContain("aGVsbG8=");
    expect(fs.files.get("cache/outbox/nonce-1/0.png")).toBe("aGVsbG8=");

    const restored = outboxDisk.load(4, new Set());
    // A refusal stays refused; anything else is sent again after a restart.
    expect(
      restored.map(({ clientNonce, state, session, heldOffline, createdAt }) => [
        clientNonce,
        state,
        session,
        heldOffline,
        createdAt,
      ]),
    ).toEqual([
      ["nonce-1", "queued", 4, true, held.createdAt],
      ["nonce-2", "refused", 4, true, held.createdAt],
      ["nonce-3", "queued", 4, true, held.createdAt],
    ]);
    expect(restored[1]!.error).toBe("Bot is archived");
    expect(restored[2]!.artifactIds.get("photo.png-5-0")).toBe("artifact-1");
    expect(restored[0]!.payload).toEqual({
      ...held.payload,
      attachments: [
        {
          ...held.payload.attachments[0],
          contentBase64: "",
          previewUri: "cache/outbox/nonce-1/0.png",
        },
      ],
    });
    await outboxDisk.hydrate(restored[0]!);
    expect(restored[0]!.payload.attachments[0]!.contentBase64).toBe("aGVsbG8=");
  });

  it("keeps the picker's preview when it still exists", () => {
    fs.files.set("cache/ImagePicker/photo.png", "aGVsbG8=");
    const held = attempt("nonce-1");
    outboxDisk.admit(held);
    outboxDisk.save([held]);
    expect(outboxDisk.load(0, new Set())[0]!.payload.attachments[0]!.previewUri).toBe(
      "cache/ImagePicker/photo.png",
    );
  });

  it("deletes a message's attachments once it is sent, cancelled or deleted", () => {
    const held = attempt("nonce-1");
    outboxDisk.admit(held);
    outboxDisk.save([held]);
    outboxDisk.forget(held);
    outboxDisk.save([]);
    expect([...fs.files.keys()]).toEqual([]);
    expect(outboxDisk.load(0, new Set())).toEqual([]);
  });

  it("removes attachment folders that no saved message refers to on launch", () => {
    const kept = attempt("nonce-1");
    const orphan = attempt("nonce-2");
    outboxDisk.admit(kept);
    outboxDisk.admit(orphan);
    outboxDisk.save([kept]);
    outboxDisk.load(0, new Set());
    expect(fs.directories.has("cache/outbox/nonce-1")).toBe(true);
    expect(fs.directories.has("cache/outbox/nonce-2")).toBe(false);
    expect(fs.files.has("cache/outbox/nonce-2/0.png")).toBe(false);
  });

  it("leaves the files of a message already in memory alone when restoring", () => {
    const saved = attempt("nonce-1");
    const accepted = attempt("nonce-2");
    outboxDisk.admit(saved);
    outboxDisk.admit(accepted);
    // Accepted and waiting to appear: off the saved list, files still in use.
    outboxDisk.save([saved]);
    expect(outboxDisk.load(0, new Set(["nonce-2"])).map((entry) => entry.clientNonce)).toEqual([
      "nonce-1",
    ]);
    expect(fs.files.get("cache/outbox/nonce-2/0.png")).toBe("aGVsbG8=");
    // Its stored size is still counted, so it isn't written or counted twice.
    expect(outboxDisk.admit(accepted)).toBe(true);
    expect(fs.directories.has("cache/outbox/nonce-2")).toBe(true);
  });

  it("refuses messages past the entry or size limit", () => {
    for (let index = 0; index < OUTBOX_MAX_ENTRIES; index += 1) {
      expect(outboxDisk.admit(attempt(`nonce-${index}`))).toBe(true);
    }
    expect(outboxDisk.admit(attempt("one-more"))).toBe(false);
    expect(fs.directories.has("cache/outbox/one-more")).toBe(false);

    outboxDisk.clear();
    // Just over half the limit each.
    const large = "A".repeat(Math.ceil((OUTBOX_MAX_BYTES * 2) / 3) + 4);
    expect(outboxDisk.admit(attempt("large-1", large))).toBe(true);
    expect(outboxDisk.admit(attempt("large-2", large))).toBe(false);
  });

  it("writes the list in full before replacing the old one, and reads the new one if the swap was cut short", () => {
    const held = attempt("nonce-1");
    outboxDisk.admit(held);
    outboxDisk.save([held]);
    expect(fs.files.has("cache/outbox/outbox.next.json")).toBe(false);
    // Interrupted after the new list was written but before it replaced the old one.
    fs.files.set("cache/outbox/outbox.next.json", fs.files.get("cache/outbox/outbox.json")!);
    fs.files.delete("cache/outbox/outbox.json");
    expect(outboxDisk.load(0, new Set()).map((entry) => entry.clientNonce)).toEqual(["nonce-1"]);
  });

  it("prefers a complete next list, falls back to the current one, and never deletes folders when either is unreadable", () => {
    const older = attempt("nonce-1");
    const newer = attempt("nonce-2");
    outboxDisk.admit(older);
    outboxDisk.save([older]);
    const oldList = fs.files.get("cache/outbox/outbox.json")!;
    outboxDisk.admit(newer);
    outboxDisk.save([older, newer]);
    const newList = fs.files.get("cache/outbox/outbox.json")!;
    // Cut short after the new list was written in full, before it replaced the old one.
    fs.files.set("cache/outbox/outbox.json", oldList);
    fs.files.set("cache/outbox/outbox.next.json", newList);
    expect(outboxDisk.load(0, new Set()).map((entry) => entry.clientNonce)).toEqual([
      "nonce-1",
      "nonce-2",
    ]);
    // Cut short while writing the new list: the current one is used, and nothing is deleted.
    fs.files.set("cache/outbox/outbox.next.json", "{ half");
    expect(outboxDisk.load(0, new Set()).map((entry) => entry.clientNonce)).toEqual(["nonce-1"]);
    expect(fs.files.has("cache/outbox/nonce-2/0.png")).toBe(true);
    // The current list is unreadable but the next one is complete.
    fs.files.set("cache/outbox/outbox.json", "{ cut off");
    fs.files.set("cache/outbox/outbox.next.json", newList);
    expect(outboxDisk.load(0, new Set()).map((entry) => entry.clientNonce)).toEqual([
      "nonce-1",
      "nonce-2",
    ]);
  });

  it("keeps every saved folder when the list can't be read", () => {
    const held = attempt("nonce-1");
    outboxDisk.admit(held);
    outboxDisk.save([held]);
    fs.files.set("cache/outbox/outbox.json", "{ cut off");
    expect(outboxDisk.load(0, new Set())).toEqual([]);
    expect(fs.files.get("cache/outbox/nonce-1/0.png")).toBe("aGVsbG8=");
  });

  it("ignores a list from another version and entries with missing fields", () => {
    const held = attempt("nonce-1");
    outboxDisk.admit(held);
    outboxDisk.save([held]);
    const list = JSON.parse(fs.files.get("cache/outbox/outbox.json")!);
    fs.files.set(
      "cache/outbox/outbox.json",
      JSON.stringify({ ...list, entries: [...list.entries, { clientNonce: "broken" }, null] }),
    );
    expect(outboxDisk.load(0, new Set()).map((entry) => entry.clientNonce)).toEqual(["nonce-1"]);
    fs.files.set("cache/outbox/outbox.json", JSON.stringify({ ...list, version: 2 }));
    expect(outboxDisk.load(0, new Set())).toEqual([]);
    expect(fs.files.get("cache/outbox/nonce-1/0.png")).toBe("aGVsbG8=");
  });

  it("gives Cancel send every file back, uploaded ones too, with a preview that outlives the folder", async () => {
    const held = attempt("nonce-1");
    held.artifactIds.set("photo.png-5-0", "artifact-1");
    outboxDisk.admit(held);
    outboxDisk.save([held]);
    const [restored] = outboxDisk.load(0, new Set());
    expect(restored!.payload.attachments[0]!.previewUri).toBe("cache/outbox/nonce-1/0.png");
    await outboxDisk.hydrate(restored!);
    expect(restored!.payload.attachments[0]!.contentBase64).toBe("");
    await outboxDisk.hydrate(restored!, { forComposer: true });
    expect(restored!.payload.attachments[0]).toMatchObject({
      contentBase64: "aGVsbG8=",
      previewUri: "data:image/png;base64,aGVsbG8=",
    });
  });

  it("deletes everything on sign-out", () => {
    const held = attempt("nonce-1");
    outboxDisk.admit(held);
    outboxDisk.save([held]);
    outboxDisk.clear();
    expect(fs.files.size).toBe(0);
    expect(outboxDisk.load(0, new Set())).toEqual([]);
  });
});
