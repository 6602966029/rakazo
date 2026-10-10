export const messageMenuSymbols = [
  "reply",
  "copy",
  "react",
  "quote",
  "speak",
  "select",
  "cancelSend",
] as const;

export type MessageMenuSymbol = (typeof messageMenuSymbols)[number];

export type MessageMenuEntry = {
  id: string;
  title: string;
  symbol?: MessageMenuSymbol;
  displayInline?: boolean;
  subactions?: MessageMenuEntry[];
};

const reactionPrefix = "reaction:";

export function messageMenuReactionId(reaction: string): string {
  return `${reactionPrefix}${reaction}`;
}

export function messageMenuReaction(id: string): string | null {
  return id.startsWith(reactionPrefix) ? id.slice(reactionPrefix.length) : null;
}

export function buildMessageContextMenu({
  labels,
  reactions,
  include,
}: {
  labels: Record<Exclude<MessageMenuSymbol, "cancelSend">, string>;
  reactions: readonly string[];
  include: { reply?: boolean; quote: boolean; react: boolean; speak: boolean; select: boolean };
}): MessageMenuEntry[] {
  const secondary: MessageMenuEntry[] = [
    ...(include.quote ? [messageMenuEntry("quote", labels.quote)] : []),
    ...(include.speak ? [messageMenuEntry("speak", labels.speak)] : []),
    ...(include.select ? [messageMenuEntry("select", labels.select)] : []),
  ];
  return [
    ...(include.reply !== false ? [messageMenuEntry("reply", labels.reply)] : []),
    messageMenuEntry("copy", labels.copy),
    ...(include.react
      ? [
          {
            ...messageMenuEntry("react", labels.react),
            subactions: reactions.map((reaction) => ({
              id: messageMenuReactionId(reaction),
              title: reaction,
            })),
          },
        ]
      : []),
    ...(secondary.length > 0
      ? [
          {
            id: "secondary",
            title: "",
            displayInline: true,
            subactions: secondary,
          },
        ]
      : []),
  ];
}

export function messageMenuEntry(symbol: MessageMenuSymbol, title: string): MessageMenuEntry {
  return { id: symbol, title, symbol };
}
