import path from "node:path";
import type { ProcessEvent } from "@rakazo/adapter-kit";
import { redactSecrets, sandboxCommandTimeoutMs } from "@rakazo/core";
import type { HostComputerEnvironment } from "./host-computer-protocol.js";
import { nativeShellCommandArgv } from "./native-shell.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import {
  isRunningShellCommand,
  observeShellCommand,
  SHELL_STILL_RUNNING_NOTICE,
} from "./shell-command-stream.js";

export const USER_COMPUTER_SHELL_TOOL = "user_computer_shell";

const USER_COMPUTER_UNAVAILABLE =
  "The user's computer is not connected. Ask them to open the Rakazo desktop app.";

/**
 * Whose own computer this run may reach: the person whose message started it, when they own the
 * bot. Routines, webhooks, channels, other bots and other people's messages reach no one's.
 */
export function userComputerOwner(input: {
  trigger: string;
  sourceRole: string | undefined;
  messagingChannelRun: boolean;
  runUserId: string;
  botUserId: string;
}): string | undefined {
  if (input.trigger !== "user" && input.trigger !== "follow_up") return undefined;
  if (input.sourceRole !== "user" || input.messagingChannelRun) return undefined;
  return input.runUserId === input.botUserId ? input.runUserId : undefined;
}

/**
 * "Allow for this chat". This tool never runs without asking first unless this check passes (see
 * gateToolCall), so an effect of it past "intended" in a run the owner started in this chat traces
 * back to their approval here. Clearing the chat detaches those runs' messages, so it asks again.
 */
export async function userComputerAllowedInChat(ctx: RunContext): Promise<boolean> {
  const { deps, run, bot, thread } = ctx;
  const allowed = await deps.prisma.externalEffect.findFirst({
    where: {
      spaceId: run.spaceId,
      kind: USER_COMPUTER_SHELL_TOOL,
      status: { in: ["approved", "executing", "completed", "uncertain"] },
      run: {
        threadId: thread.id,
        botId: bot.id,
        userId: run.userId,
        sourceMessage: { is: { threadId: thread.id } },
      },
    },
    select: { id: true },
  });
  return Boolean(allowed);
}

/** The working directory on the user's computer: their home unless the call names another. */
export function userComputerCwd(environment: HostComputerEnvironment, cwd: unknown): string {
  const paths = environment.platform === "win32" ? path.win32 : path.posix;
  const requested = typeof cwd === "string" ? cwd.trim() : "";
  if (!requested || requested === "~") return environment.home;
  const expanded = /^~[\\/]/.test(requested)
    ? paths.join(environment.home, requested.slice(2))
    : requested;
  return paths.resolve(environment.home, expanded);
}

async function lastValue<T>(values: AsyncIterable<T>): Promise<T> {
  let result: { value: T } | undefined;
  for await (const value of values) result = { value };
  if (!result) throw new Error("no response");
  return result.value;
}

export async function userComputerShell(ctx: RunContext, call: ToolCall) {
  const { deps, bot, runId } = ctx;
  const owner = ctx.source.userComputerOwner;
  const devices = deps.userDevices;
  // Checked again at execution: the desktop can disconnect or be revoked after the offer.
  if (!owner || !devices || !(await devices.connected(owner).catch(() => null))) {
    return call.finish({ error: USER_COMPUTER_UNAVAILABLE });
  }
  const { signal } = ctx.context;
  const command = String(call.args.command ?? "");
  try {
    // The device only executes for a provisioned bot; provisioning is idempotent.
    await lastValue(devices.request(owner, { method: "provision", botId: bot.id, runId }, signal));
    const environment = await lastValue(
      devices.request<HostComputerEnvironment>(
        owner,
        { method: "environment", botId: bot.id, runId },
        signal,
      ),
    );
    const observed = await observeShellCommand(
      devices.request<ProcessEvent>(
        owner,
        {
          method: "execute",
          botId: bot.id,
          runId,
          command: {
            argv: nativeShellCommandArgv(command, environment),
            cwd: userComputerCwd(environment, call.args.cwd),
            timeoutMs: sandboxCommandTimeoutMs(),
          },
        },
        signal,
      ),
      { secrets: ctx.secrets },
    );
    if (!observed.completion) return call.finish(observed.result);
    void observed.completion.catch(() => undefined);
    const returned = await call.finish({ ...observed.result, notice: SHELL_STILL_RUNNING_NOTICE });
    if (isRunningShellCommand(returned)) call.observer?.onShellStillRunning?.(observed.completion);
    return returned;
  } catch (error) {
    if (signal.aborted) throw error;
    const reason = redactSecrets(
      error instanceof Error ? error.message : "command failed",
      ctx.secrets,
    );
    return call.finish({ error: `The user's computer did not finish the command: ${reason}` });
  }
}
