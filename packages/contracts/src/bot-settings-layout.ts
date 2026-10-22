/** Shared section membership and order; surfaces omit unavailable capabilities. */
export const BOT_SETTINGS_SECTIONS = {
  behavior: ["instructions", "model", "thinking"],
  openWork: ["scratchpad"],
  memory: ["knowledge"],
  tools: ["disabledTools", "credentials"],
  advanced: ["computer", "memoryScope", "readAloud", "voice", "fleetManagement"],
} as const;

export const BOT_SETTINGS_ADVANCED_ORDER = BOT_SETTINGS_SECTIONS.advanced;

/** Labels stay literal in each platform's translation calls. */
export const BOT_COMPUTER_MODES = ["team", "dedicated"] as const;
