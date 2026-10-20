import type { MessageBlock } from "@rakazo/contracts";

/** Deliberately narrow: complete tokens only, never substrings of prose or short handles. */
export function isOpaqueName(name: string): boolean {
  return (
    /^__[A-Za-z0-9_-]+__$/.test(name) ||
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(name) ||
    // Cuid v1 has a fixed prefix/length; cuid2 is 24 lowercase alphanumerics.
    /^c[a-z0-9]{24}$/.test(name) ||
    (/^[a-z][a-z0-9]{23}$/.test(name) && /[0-9]/.test(name)) ||
    // Longer nanoid-like handles need all three classes to avoid ordinary names.
    (/^[A-Za-z0-9_-]{20,}$/.test(name) &&
      /[a-z]/.test(name) &&
      /[A-Z]/.test(name) &&
      /[0-9]/.test(name))
  );
}

export function displayName(name: string | null | undefined, fallback: string): string {
  const trimmed = name?.trim() ?? "";
  return trimmed && /[\p{L}\p{N}]/u.test(trimmed) && !isOpaqueName(trimmed) ? trimmed : fallback;
}

export function accountDisplay(
  account: { name?: string | null; email?: string | null; image?: string | null },
  fallback: string,
): { label: string; initial: string | null; image: string | null } {
  const email = account.email?.trim() ?? "";
  const name = displayName(account.name, "");
  const comparable = name.toLowerCase();
  const emailDerived =
    email &&
    (comparable === email.toLowerCase() || comparable === email.split("@")[0]?.toLowerCase());
  const label = (emailDerived ? "" : name) || email || fallback;
  return {
    label,
    initial: label.match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() ?? null,
    image: account.image || null,
  };
}

/** Only identity metadata changes; message text, filenames and tool identifiers stay literal. */
export function displayMessageBlock(block: MessageBlock): MessageBlock {
  switch (block.kind) {
    case "bot_message_sent":
      return { ...block, toBotName: displayName(block.toBotName, "Bot") };
    case "bot_message_received":
      return { ...block, fromBotName: displayName(block.fromBotName, "Bot") };
    case "subagent":
      return { ...block, name: displayName(block.name, "subagent") };
    case "child_bot":
      return { ...block, name: displayName(block.name, "Bot") };
    case "channel_message":
      return { ...block, fromLabel: displayName(block.fromLabel, "Member") };
    default:
      return block;
  }
}
