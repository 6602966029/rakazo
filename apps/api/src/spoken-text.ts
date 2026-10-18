import type { MessageBlock } from "@rakazo/contracts";
import { speakable, speechFromBlocks } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

export type SpokenTextResolver = (input: {
  prisma: PrismaClient;
  botId: string;
  threadId: string;
  messageId: string;
  blocks: MessageBlock[];
}) => Promise<string>;

export type HostSpeaker = (input: {
  prisma: PrismaClient;
  botId: string;
  text: string;
  speakOnHost: boolean;
}) => Promise<boolean>;

let spokenTextResolver: SpokenTextResolver | null = null;
const hostSpeakers = new WeakMap<object, HostSpeaker>();

/** Optional reply-text override. Unset, the spoken line is the full reply. */
export function registerSpokenTextResolver(fn: SpokenTextResolver): void {
  spokenTextResolver = fn;
}

/** Optional host playback, keyed by the router deps object. Unset, the browser speaks. */
export function registerHostSpeaker(key: object, fn: HostSpeaker): void {
  hostSpeakers.set(key, fn);
}

export async function resolveSpokenText(input: {
  prisma: PrismaClient;
  botId: string;
  threadId: string;
  messageId: string;
  blocks: MessageBlock[];
}): Promise<string> {
  if (spokenTextResolver) return spokenTextResolver(input);
  return speakable(speechFromBlocks(input.blocks));
}

export async function speakOnHost(
  key: object,
  input: {
    prisma: PrismaClient;
    botId: string;
    text: string;
    speakOnHost: boolean;
  },
): Promise<boolean> {
  const speaker = hostSpeakers.get(key);
  if (!speaker) return false;
  return speaker(input);
}
