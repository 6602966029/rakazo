export type InboundRoutine = { name: string; prompt: string };

/** How an inbound delivery (webhook, GitHub, messaging) quotes a routine it runs. */
export function inboundRoutineBlock(routine: InboundRoutine): string {
  return `Run routine "${routine.name}":\n${routine.prompt.trim()}`;
}

/**
 * The prompts of the routines an inbound task starts with. Those blocks come first and the
 * untrusted payload after them, and each must match one of `routines` exactly, so text in the
 * payload can never be taken for the owner's instructions.
 */
export function inboundRoutinePrompts(taskPrompt: string, routines: InboundRoutine[]): string[] {
  const prompts: string[] = [];
  let rest = taskPrompt;
  for (;;) {
    const routine = routines.find((candidate) =>
      rest.startsWith(`${inboundRoutineBlock(candidate)}\n`),
    );
    if (!routine) return prompts;
    prompts.push(routine.prompt.trim());
    rest = rest.slice(inboundRoutineBlock(routine).length + 1);
  }
}
