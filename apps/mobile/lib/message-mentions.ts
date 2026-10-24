import type { ReactNode } from "react";
import { createContext } from "react";

/** The bots a reply announces, which its text names inline. */
export const MessageMentionsContext = createContext<
  | { mentions: readonly { id: string; name: string }[]; render: (id: string) => ReactNode }
  | undefined
>(undefined);
