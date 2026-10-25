import { plainTextFromMarkdown, replyAttachment, resolvePersonaColorDef } from "@rakazo/core";
import type { MobileBot, MobileMessage, MobileSnapshot } from "./api";
import { messagingProviderLabel } from "./api";
import { t } from "./i18n";

export function previewMessageText(message: MobileMessage): string {
  const text = message.blocks
    .flatMap((block) => {
      if (block.kind === "channel_message" && block.text) {
        return [
          `${block.fromLabel} (${messagingProviderLabel(block.provider, block.transport)}): ${block.text}`,
        ];
      }
      if (block.kind === "text" && block.text) {
        // Bot text is Markdown; user text is already plain.
        return [message.role === "bot" ? plainTextFromMarkdown(block.text) : block.text];
      }
      return [];
    })
    .join(" ")
    .trim();
  if (text) return text;
  const attachment = replyAttachment(message.blocks);
  if (attachment)
    return attachment.kind === "image" ? t("Photo") : attachment.name || t("Attachment");
  return t("Message");
}

export function memberName(
  members: MobileSnapshot["members"] | undefined,
  botId: string | undefined,
): string | undefined {
  if (!botId || !members) return undefined;
  return members.find((member) => member.botId === botId)?.name;
}

/** Each bot keeps one identity color across web and mobile — same lookup as the avatar. */
export function speakerColorFor(
  bots: MobileBot[],
  members: MobileSnapshot["members"] | undefined,
  botId: string | undefined,
): string | undefined {
  if (!botId) return undefined;
  const raw =
    bots.find((bot) => bot.id === botId)?.color ??
    members?.find((member) => member.botId === botId)?.color;
  return resolvePersonaColorDef(botId, raw).light;
}
