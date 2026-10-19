import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { Evidence } from "./cases.js";
import type { RoutineEvidence } from "./silence.js";
import { SILENCE_EVAL_CASES } from "./silence.js";

function evidence(run: Partial<RoutineEvidence> = {}): Evidence {
  const routineRun: RoutineEvidence = {
    text: "",
    unread: false,
    messages: [],
    progress: [],
    notifications: [],
    calls: [
      { tool: "GITHUB_LIST_RELEASES", args: { owner: "example", repo: "widget" }, outcome: "read" },
    ],
    observedCompletion: true,
    ...run,
  };
  return {
    text: routineRun.text,
    files: {},
    records: [],
    notes: [],
    calls: routineRun.calls,
    routines: [],
    memory: "",
    approvalPending: false,
    pendingApproval: null,
    priorMemory: "",
    destinationWrites: 0,
    toolNames: [],
    messaging: { originThreadId: null, outbound: [] },
    routineRuns: [routineRun],
  };
}
const grade = (e: Evidence) => SILENCE_EVAL_CASES[0]!.grade(e);
const passes = (e: Evidence) => grade(e).every((c) => c.pass);

describe("silence outcome grading", () => {
  it("accepts a verified quiet check", () => expect(passes(evidence())).toBe(true));
  it.each([
    { kind: "text", text: "No changes." },
    { kind: "text", text: "NO_RESPONSE" },
    { kind: "text", text: "" },
    { kind: "progress", text: "Checking now." },
  ] as MessageBlock[])("rejects a persisted $kind block even with an empty final text", (block) => {
    expect(passes(evidence({ messages: [[block]] }))).toBe(false);
  });
  it("rejects an empty persisted bubble", () =>
    expect(passes(evidence({ messages: [[]] }))).toBe(false));
  it("allows hidden tool audit blocks", () => {
    expect(passes(evidence({ messages: [[{ kind: "steps", steps: [] }]] }))).toBe(true);
  });
  it("rejects an unread badge without a message", () =>
    expect(passes(evidence({ unread: true }))).toBe(false));
  it("rejects transient progress already removed from chat", () => {
    expect(passes(evidence({ progress: [{ text: "Checking...", streaming: true }] }))).toBe(false);
  });
  it("rejects a notification without a chat bubble", () => {
    expect(
      passes(
        evidence({
          notifications: [
            {
              kind: "completion",
              title: "Done",
              body: "All clear",
              botId: "bot",
              threadId: "thread",
            },
          ],
        }),
      ),
    ).toBe(false);
  });
  it("rejects silence without checking the source", () =>
    expect(passes(evidence({ calls: [] }))).toBe(false));
  it("rejects a failed source check", () => {
    expect(
      passes(
        evidence({
          calls: [
            {
              tool: "GITHUB_LIST_RELEASES",
              args: { owner: "example", repo: "widget" },
              outcome: "rejected",
            },
          ],
        }),
      ),
    ).toBe(false);
  });
  it("rejects missing observation instead of treating it as silence", () => {
    const e = evidence();
    delete e.routineRuns;
    expect(passes(e)).toBe(false);
    expect(passes(evidence({ observedCompletion: false }))).toBe(false);
  });
  it("rejects writes in earlier wakes too", () => {
    const e = evidence();
    e.routineRuns!.push({
      ...e.routineRuns![0]!,
      calls: [{ tool: "CRM_CREATE_NOTE", args: {}, outcome: "write" }],
    });
    expect(SILENCE_EVAL_CASES[2]!.grade(e)).toContainEqual({
      id: "no-external-writes",
      pass: false,
    });
  });
});
