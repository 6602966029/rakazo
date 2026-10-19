import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ComputerRef, ProcessEvent } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureComputerWorkspaceLayout,
  removeComputerWorkspaceDirectories,
} from "./computer-workspace.js";
import { HostComputerSandbox } from "./host-computer-sandbox.js";
import { startHostComputerServer } from "./host-computer-server.js";
import { nativeShellCommandArgv } from "./native-shell.js";

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "test",
  userId: "test",
  signal: new AbortController().signal,
};
const token = "ab".repeat(32);

describe("native host computer transport", () => {
  let root: string;
  let server: Awaited<ReturnType<typeof startHostComputerServer>>;
  let client: HostComputerSandbox;
  let url: string;
  let computer: ComputerRef;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "rakazo-host-test-")));
    server = await startHostComputerServer({ root, token, hostname: "127.0.0.1" });
    url = `http://127.0.0.1:${server.port}`;
    client = new HostComputerSandbox(url, token);
    server.setEnabled(true);
    computer = await client.provision({ botId: "test-bot", homePath: "/unused" }, context);
  });
  afterEach(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  it("requires both native consent and authentication and rejects browser origins", async () => {
    const body = JSON.stringify({ method: "provision", botId: "test" });
    expect((await fetch(`${url}/computer`, { method: "POST", body })).status).toBe(401);
    expect(
      (
        await fetch(`${url}/computer`, {
          method: "POST",
          body,
          headers: { authorization: `Bearer ${"cd".repeat(32)}` },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${url}/computer`, {
          method: "POST",
          body,
          headers: { authorization: `Bearer ${token}`, origin: "https://example.test" },
        })
      ).status,
    ).toBe(401);
    server.setEnabled(false);
    await expect(client.provision({ botId: "no-consent", homePath: "" }, context)).rejects.toThrow(
      "unavailable",
    );
    server.setEnabled(true);
    expect(
      (
        await fetch(`${url}/computer`, {
          method: "POST",
          body: JSON.stringify({ method: "execute", botId: "test", command: { argv: "bad" } }),
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(400);
  });

  it("streams real host commands and preserves literal arguments and environment removals", async () => {
    const payload = "$(echo unsafe); & |";
    const events = await collect(
      client.execute(
        computer,
        {
          argv: [
            process.execPath,
            "-e",
            "console.log(process.argv[1]); console.error(process.env.RAKAZO_TEST_REMOVED ?? 'unset')",
            payload,
          ],
          env: { RAKAZO_TEST_REMOVED: "remove" },
          unsetEnv: ["RAKAZO_TEST_REMOVED"],
        },
        context,
      ),
    );
    expect(
      events
        .filter((event) => event.type === "stdout")
        .map((event) => event.data)
        .join(""),
    ).toBe(`${payload}\n`);
    expect(events).toContainEqual({ type: "stderr", data: "unset\n" });
    expect(events.at(-1)).toEqual({ type: "exit", code: 0 });
    expect(await client.environment(computer, context)).toMatchObject({
      platform: process.platform,
    });
  });

  it("uses the host shell for the real shell tool, including PowerShell on Windows", async () => {
    const environment = await client.environment(computer, context);
    const command =
      environment.platform === "win32"
        ? "Write-Output 'native-shell-ok'"
        : "printf 'native-shell-ok\\n'";
    const events = await collect(
      client.execute(computer, { argv: nativeShellCommandArgv(command, environment) }, context),
    );
    expect(
      events
        .filter((event) => event.type === "stdout")
        .map((event) => event.data)
        .join("")
        .trim(),
    ).toBe("native-shell-ok");
    expect(events.at(-1)).toEqual({ type: "exit", code: 0 });
  });

  it("creates and cleans Team folders without Unix command tools", async () => {
    await ensureComputerWorkspaceLayout(client, computer, "team", "bot-1", context);
    expect(await client.workspaceDirectories(computer, { action: "list" }, context)).toEqual([
      "bots/bot-1",
    ]);
    await client.writeFile(
      computer,
      { path: "bots/bot-1/file.txt", content: new TextEncoder().encode("test") },
      context,
    );
    await expect(
      removeComputerWorkspaceDirectories(client, computer, "bots", ["../shared", "bot-1"], context),
    ).rejects.toThrow("escapes");
    expect(await client.workspaceDirectories(computer, { action: "list" }, context)).toEqual([]);
  });

  it("unlinks a deleted bot's symlink without following it and refuses a linked parent", async () => {
    await ensureComputerWorkspaceLayout(client, computer, "team", "bot-1", context);
    const [directory] = await readdir(path.join(root, "desktop-computers"));
    const home = path.join(root, "desktop-computers", directory!);
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "keep.txt"), "keep");
    await symlink(
      outside,
      path.join(home, "bots", "linked-bot"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await removeComputerWorkspaceDirectories(client, computer, "bots", ["linked-bot"], context);
    expect(await readFile(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
    await symlink(
      outside,
      path.join(home, ".browser-profiles"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      removeComputerWorkspaceDirectories(
        client,
        computer,
        ".browser-profiles",
        [`chromium-bot-${"a".repeat(32)}`],
        context,
      ),
    ).rejects.toThrow("escapes");
    expect(await readFile(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
  });

  it("cancels only commands belonging to the requested run", async () => {
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const running = (async () => {
      for await (const event of client.execute(
        computer,
        { argv: [process.execPath, "-e", "console.log('ready'); setInterval(() => {}, 1000)"] },
        { ...context, runId: "target-run" },
      )) {
        if (event.type === "stdout") ready();
      }
    })();
    const rejected = expect(running).rejects.toThrow();
    await started;
    await client.cancelRunWork(computer, "computer-id", "another-run", context);
    expect(await client.isRunning(computer, context)).toBe(true);
    await client.cancelRunWork(computer, "computer-id", "target-run", context);
    await rejected;
    expect(await client.isRunning(computer, context)).toBe(true);
  });

  it("keeps cancellation available when every execution slot is occupied", async () => {
    let ready!: () => void;
    let started = 0;
    const allStarted = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const runs = Array.from({ length: 16 }, () =>
      (async () => {
        for await (const event of client.execute(
          computer,
          { argv: [process.execPath, "-e", "console.log('ready'); setInterval(() => {}, 1000)"] },
          { ...context, runId: "saturated-run" },
        )) {
          if (event.type === "stdout" && ++started === 16) ready();
        }
      })(),
    );
    const settled = Promise.allSettled(runs);
    await allStarted;
    await client.cancelRunWork(computer, "computer-id", "saturated-run", context);
    expect((await settled).every((result) => result.status === "rejected")).toBe(true);
  });

  it("round trips portable files and never treats an opaque reference as a host path", async () => {
    const content = new Uint8Array([0, 255, 13, 10, 128]);
    await client.writeFile(
      { ...computer, providerRef: path.parse(root).root },
      { path: "nested/file.bin", content },
      context,
    );
    expect(await client.readFile(computer, "nested/file.bin", context)).toEqual(content);
    expect(await client.listFiles(computer, "nested", context)).toMatchObject([
      { path: "nested/file.bin", kind: "file", size: 5 },
    ]);
    const files = await collect(client.exportWorkspace(computer, context));
    expect(files).toMatchObject([{ path: "nested/file.bin", content }]);
    await expect(client.readFile(computer, "../../outside", context)).rejects.toThrow();
    await expect(
      client.writeFile(computer, { path: "../outside", content }, context),
    ).rejects.toThrow();
    await expect(
      client.readFile(computer, "nested/file.bin", context, { maxBytes: 2 }),
    ).rejects.toThrow();
  });

  it.each(["revoke", "cancel"])(
    "%s owns background children after their shell request finishes",
    async (action) => {
      const command =
        "const {spawn} = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'}); child.unref(); console.log(child.pid)";
      const result = await collect(
        client.execute(
          computer,
          { argv: [process.execPath, "-e", command] },
          { ...context, runId: "background-run" },
        ),
      );
      const pid = Number(
        result
          .filter((event) => event.type === "stdout")
          .map((event) => event.data)
          .join("")
          .trim(),
      );
      expect(result.at(-1)).toEqual({ type: "exit", code: 0 });
      expect(processExists(pid)).toBe(true);
      if (action === "revoke") server.setEnabled(false);
      else await client.cancelRunWork(computer, "computer-id", "background-run", context);
      await expect.poll(() => processExists(pid)).toBe(false);
    },
  );

  it("revocation terminates running commands and refuses subsequent operations", async () => {
    const events: ProcessEvent[] = [];
    let pid = 0;
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const running = (async () => {
      for await (const event of client.execute(
        computer,
        { argv: [process.execPath, "-e", "console.log(process.pid); setInterval(() => {}, 1000)"] },
        context,
      )) {
        events.push(event);
        if (event.type === "stdout") {
          pid = Number(event.data.trim());
          ready();
        }
      }
    })();
    const rejected = expect(running).rejects.toThrow();
    await started;
    server.setEnabled(false);
    await rejected;
    await expect.poll(() => processExists(pid)).toBe(false);
    expect(events.some((event) => event.type === "stdout")).toBe(true);
    await expect(client.readFile(computer, "file", context)).rejects.toThrow("unavailable");
  });

  it("cancels the host process on client abort and rejects graphical operations", async () => {
    const controller = new AbortController();
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const running = (async () => {
      for await (const event of client.execute(
        computer,
        { argv: [process.execPath, "-e", "console.log('started'); setInterval(() => {}, 1000)"] },
        { ...context, signal: controller.signal },
      )) {
        if (event.type === "stdout") ready();
      }
    })();
    const rejected = expect(running).rejects.toThrow();
    await started;
    controller.abort();
    await rejected;
    await expect(client.connectScreen()).rejects.toThrow("unavailable");
    expect(client.describe().capabilities.graphical).toBe(false);
  });
});

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const item of items) values.push(item);
  return values;
}

function processExists(pid: number) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
