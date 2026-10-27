// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ messages: vi.fn() }));
vi.mock("../lib/rpc", () => {
  const client = { threads: api };
  return {
    rpc: client,
    rpcForSpace: () => client,
    createSpaceRpc: () => client,
    selectedSpaceId: () => null,
  };
});
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));
vi.mock("@rakazo/ui-web", () => {
  const Container = ({ children, ...props }: { children?: ReactNode }) => (
    <div {...props}>{children}</div>
  );
  return {
    BotAvatar: () => null,
    Button: Container,
    Dialog: Container,
    DialogClose: Container,
    DialogContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    DialogTitle: Container,
    Spinner: () => null,
  };
});

import { PeerMessagesOverlay } from "./PeerMessagesOverlay";

const scrollHeight = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get");
const clientHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get");

afterEach(() => {
  document.body.innerHTML = "";
  api.messages.mockReset();
});

function exchange(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    blocks: [
      { kind: "bot_message_sent", toBotId: "peer", toBotName: "Researcher", text: `note ${index}` },
    ],
  }));
}

async function open() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    createRoot(container).render(
      <QueryClientProvider client={queryClient}>
        <PeerMessagesOverlay
          botId="chief"
          botName="Chief"
          botColor="blue"
          peerBotId="peer"
          peerBotName="Researcher"
          peerBotColor="green"
          onClose={() => undefined}
        />
      </QueryClientProvider>,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  return container.querySelector<HTMLElement>('[data-testid="peer-conversation-transcript"]');
}

it("opens a long exchange at its latest message", async () => {
  scrollHeight.mockReturnValue(5_000);
  clientHeight.mockReturnValue(600);
  api.messages.mockResolvedValue({ messages: exchange(40), olderCursor: null });

  const transcript = await open();

  expect(transcript?.textContent).toContain("note 39");
  expect(transcript?.scrollTop).toBe(5_000);
});
