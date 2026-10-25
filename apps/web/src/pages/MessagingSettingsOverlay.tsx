import { Trans, useLingui } from "@lingui/react/macro";
import type {
  Bot,
  ExternalConversation,
  MessagingAgentConnection,
  MessagingChannelMembership,
  MessagingInstallationsStatus,
  MessagingStatus,
} from "@rakazo/contracts";
import { isRetryableError } from "@rakazo/core";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  NativeSelect,
  NativeSelectOption,
} from "@rakazo/ui-web";
import { ChevronDownIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import { providerLabel } from "../lib/messaging";
import { rpc } from "../lib/rpc";
import { ExternalConversationSettings } from "./ExternalConversationSettings";

const LINK_POLL_MS = 3_000;

function Row({ children, actions }: { children: ReactNode; actions: ReactNode }) {
  return (
    <li className="flex items-center justify-between gap-3 text-[14px] text-foreground/75">
      <span className="min-w-0 truncate">{children}</span>
      <span className="flex shrink-0 gap-2">{actions}</span>
    </li>
  );
}

function Meta({ children }: { children: ReactNode }) {
  return <span className="ml-2 text-[12px] text-muted-foreground/70">{children}</span>;
}

export function MessagingSettingsOverlay({ onClose }: { onClose: () => void }) {
  const { t } = useLingui();
  const [installationStatus, setInstallationStatus] = useState<MessagingInstallationsStatus>({
    available: false,
    installations: [],
  });
  const [status, setStatus] = useState<MessagingStatus | null>(null);
  const [channels, setChannels] = useState<MessagingChannelMembership[]>([]);
  const [connections, setConnections] = useState<MessagingAgentConnection[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const [externalConversations, setExternalConversations] = useState<ExternalConversation[]>([]);
  const [settingsConversationId, setSettingsConversationId] = useState<string | null>(null);
  const [selectedBotId, setSelectedBotId] = useState("");
  const [linkRequest, setLinkRequest] = useState<{
    code: string;
    expiresAt: string;
    botId: string;
    provider: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const [nextStatus, nextChannels, nextConnections, nextBots, navigation, installations] =
      await Promise.all([
        rpc.messaging.status(),
        rpc.messaging.channels.list(),
        rpc.messaging.connections.list(),
        rpc.bots.list(),
        rpc.spaces.list(),
        rpc.messaging.installations.list(),
      ]);
    setInstallationStatus(installations);
    setStatus(nextStatus);
    setChannels(nextChannels);
    setConnections(nextConnections);
    setBots(nextBots);
    setExternalConversations(navigation.current.externalConversations);
  }

  useEffect(() => {
    void refresh().catch(() => setError(t`Couldn't load messaging settings`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Linking completes in the chat app: watch for a new or reassigned identity.
  useEffect(() => {
    if (!linkRequest) return;
    const known = new Map(status?.identities.map((identity) => [identity.id, identity.botId]));
    let active = true;
    let poll: number;
    const expire = window.setTimeout(
      () => {
        active = false;
        window.clearTimeout(poll);
        setLinkRequest(null);
      },
      Math.max(0, Date.parse(linkRequest.expiresAt) - Date.now()),
    );
    async function pollStatus() {
      try {
        const next = await rpc.messaging.status();
        if (!active) return;
        if (
          next.identities.some(
            (identity) =>
              identity.botId === linkRequest?.botId && known.get(identity.id) !== identity.botId,
          )
        ) {
          active = false;
          window.clearTimeout(expire);
          setStatus(next);
          setLinkRequest(null);
          await refresh();
        }
      } catch (error) {
        // A transient failure can be retried while the code is valid.
        if (!isRetryableError(error)) active = false;
      } finally {
        if (active) poll = window.setTimeout(() => void pollStatus(), LINK_POLL_MS);
      }
    }
    poll = window.setTimeout(() => void pollStatus(), LINK_POLL_MS);
    return () => {
      active = false;
      window.clearTimeout(poll);
      window.clearTimeout(expire);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkRequest]);

  async function act(action: () => Promise<unknown>) {
    setError(null);
    // A displayed code must always match the current selection and link
    // state; the link action re-sets it after issuing.
    setLinkRequest(null);
    try {
      await action();
      await refresh();
    } catch {
      setError(t`Couldn't update messaging settings`);
    }
  }

  useEffect(() => {
    const onFocus = () => {
      void refresh().catch(() => setError(t`Couldn't load messaging settings`));
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const linkBotId = selectedBotId || bots[0]?.id || "";
  const botName = (botId: string) => bots.find((bot) => bot.id === botId)?.name;
  // Only meaningful once a second chat app is linked: the same group can then
  // hold two of the caller's memberships, one per agent.
  const agentByIdentity = new Map(status?.identities.map((i) => [i.id, i.botName]) ?? []);
  function channelMeta(channel: MessagingChannelMembership): string {
    return [
      providerLabel(channel.provider),
      agentByIdentity.size > 1 ? agentByIdentity.get(channel.identityId) : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  // Slack installs workspace-wide when this server supports it; every other
  // app links with a code sent from the chat app.
  const codeProviders = (status?.providers ?? []).filter(
    (provider) => provider !== "slack" || !installationStatus.available,
  );
  const invitedChannels = channels.filter((channel) => channel.status === "invited");
  const incomingConnections = connections.filter(
    (connection) => connection.status === "pending" && connection.incoming,
  );
  const joinedChannels = channels.filter((channel) => channel.status === "approved");
  const otherConnections = connections.filter(
    (connection) =>
      connection.status === "approved" || (connection.status === "pending" && !connection.incoming),
  );
  const linkedCount = (status?.identities.length ?? 0) + installationStatus.installations.length;
  const hasRequests = invitedChannels.length > 0 || incomingConnections.length > 0;
  const hasConversations =
    joinedChannels.length > 0 || otherConnections.length > 0 || externalConversations.length > 0;

  const linkCode = linkRequest?.code;
  const linkApp = linkRequest ? providerLabel(linkRequest.provider) : "";

  function startLink(provider: string) {
    void act(async () => {
      const issued = await rpc.messaging.link.start({ botId: linkBotId });
      setLinkRequest({ ...issued, botId: linkBotId, provider });
    });
  }

  function installSlack() {
    const popup = window.open("about:blank", "rakazo-slack-install");
    if (popup) popup.opener = null;
    void act(async () => {
      try {
        const { url } = await rpc.messaging.installations.start({ botId: linkBotId });
        if (popup) popup.location.href = url;
        else window.location.assign(url);
      } catch (error) {
        popup?.close();
        throw error;
      }
    });
  }

  const respondButtons = (respond: (accept: boolean) => Promise<unknown>) => (
    <>
      <Button size="sm" onClick={() => void act(() => respond(true))}>
        <Trans>Approve</Trans>
      </Button>
      <Button size="sm" variant="secondary" onClick={() => void act(() => respond(false))}>
        <Trans>Decline</Trans>
      </Button>
    </>
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-testid="messaging-settings"
        showCloseButton={false}
        className="rk-scroll block max-h-[calc(100%-2rem)] w-[560px] overflow-y-auto rounded-2xl p-6 sm:max-h-[calc(100%-5rem)] sm:max-w-[calc(100%-5rem)] sm:p-8"
      >
        <div className="flex items-start justify-between gap-6">
          <DialogTitle className="text-heading2 font-medium text-foreground">
            <Trans>Messaging</Trans>
          </DialogTitle>
          <DialogClose
            aria-label={t`Close messaging settings`}
            render={<Button variant="ghost" size="icon-sm" />}
          >
            <XIcon />
          </DialogClose>
        </div>

        {error ? <p className="mt-4 text-[13px] text-destructive">{error}</p> : null}

        {hasRequests ? (
          <section className="mt-6">
            <h3 className="text-[13px] font-medium text-muted-foreground">
              <Trans>Requests</Trans>
            </h3>
            <ul className="mt-3 space-y-3">
              {invitedChannels.map((channel) => (
                <Row
                  key={channel.id}
                  actions={respondButtons((accept) =>
                    rpc.messaging.channels.respond({ membershipId: channel.id, accept }),
                  )}
                >
                  {channel.name ?? t`Group`}
                  <Meta>{channelMeta(channel)}</Meta>
                </Row>
              ))}
              {incomingConnections.map((connection) => (
                <Row
                  key={connection.id}
                  actions={respondButtons((accept) =>
                    rpc.messaging.connections.respond({ connectionId: connection.id, accept }),
                  )}
                >
                  {connection.peerOwnerLabel}
                  {"'s "}
                  {connection.peerBotName}
                </Row>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="mt-6">
          {linkedCount > 0 ? (
            <ul className="mb-4 space-y-3">
              {status?.identities.map((identity) => (
                <Row
                  key={identity.id}
                  actions={
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void act(() => rpc.messaging.identities.unlink({ identityId: identity.id }))
                      }
                    >
                      <Trans>Unlink</Trans>
                    </Button>
                  }
                >
                  <span className="text-foreground">{providerLabel(identity.provider)}</span>
                  <Meta>
                    {identity.address} · {identity.botName}
                  </Meta>
                </Row>
              ))}
              {installationStatus.installations.map((installation) => (
                <Row
                  key={installation.id}
                  actions={
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void act(() => rpc.messaging.installations.remove({ id: installation.id }))
                      }
                    >
                      <Trans>Disconnect</Trans>
                    </Button>
                  }
                >
                  <span className="text-foreground">{providerLabel(installation.provider)}</span>
                  <Meta>
                    {[installation.workspaceName, botName(installation.botId)]
                      .filter(Boolean)
                      .join(" · ")}
                  </Meta>
                </Row>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {bots.length > 1 ? (
              <NativeSelect
                aria-label={t`Bot`}
                value={linkBotId}
                onChange={(event) => {
                  setSelectedBotId(event.target.value);
                  setLinkRequest(null);
                }}
              >
                {bots.map((bot) => (
                  <NativeSelectOption key={bot.id} value={bot.id}>
                    {bot.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={!linkBotId || (!codeProviders.length && !installationStatus.available)}
                render={<Button variant="outline" />}
              >
                <Trans>Connect a chat app</Trans>
                <ChevronDownIcon data-icon="inline-end" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-auto min-w-44">
                {installationStatus.available ? (
                  <DropdownMenuItem onClick={installSlack}>
                    {providerLabel("slack")}
                  </DropdownMenuItem>
                ) : null}
                {codeProviders.map((provider) => (
                  <DropdownMenuItem key={provider} onClick={() => startLink(provider)}>
                    {providerLabel(provider)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {linkCode ? (
            <p className="mt-3 text-[14px] text-foreground/75" data-testid="messaging-link-code">
              <Trans>
                Send <span className="font-mono text-foreground">{linkCode}</span> from {linkApp}{" "}
                within 10 minutes.
              </Trans>
            </p>
          ) : null}
        </section>

        {hasConversations ? (
          <section className="mt-8">
            <h3 className="text-[13px] font-medium text-muted-foreground">
              <Trans>Conversations</Trans>
            </h3>
            <ul className="mt-3 space-y-3">
              {joinedChannels.map((channel) => (
                <Row
                  key={channel.id}
                  actions={
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void act(() => rpc.messaging.channels.leave({ membershipId: channel.id }))
                      }
                    >
                      <Trans>Leave</Trans>
                    </Button>
                  }
                >
                  {channel.name ?? t`Group`}
                  <Meta>{channelMeta(channel)}</Meta>
                </Row>
              ))}
              {otherConnections.map((connection) => (
                <Row
                  key={connection.id}
                  actions={
                    connection.status === "approved" ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          void act(() =>
                            rpc.messaging.connections.revoke({ connectionId: connection.id }),
                          )
                        }
                      >
                        <Trans>Revoke</Trans>
                      </Button>
                    ) : (
                      <Meta>
                        <Trans>Pending</Trans>
                      </Meta>
                    )
                  }
                >
                  {connection.peerOwnerLabel}
                  {"'s "}
                  {connection.peerBotName}
                </Row>
              ))}
              {externalConversations.map((conversation) => {
                const bot = bots.find((candidate) => candidate.id === conversation.botId);
                const open = settingsConversationId === conversation.id;
                return (
                  <li key={conversation.id} className="text-[14px] text-foreground/75">
                    <div className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate">
                        {conversation.displayName || t`External conversation`}
                        <Meta>{providerLabel(conversation.provider)}</Meta>
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setSettingsConversationId(open ? null : conversation.id)}
                      >
                        {open ? <Trans>Close</Trans> : <Trans>Settings</Trans>}
                      </Button>
                    </div>
                    {open && bot ? (
                      <div className="mt-4 rounded-lg border border-border px-3 py-3">
                        <ExternalConversationSettings
                          conversation={conversation}
                          bot={bot}
                          onSave={async (policy) => {
                            await rpc.externalConversations.updatePolicy({
                              externalConversationId: conversation.id,
                              ...policy,
                            });
                            await refresh();
                          }}
                        />
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
