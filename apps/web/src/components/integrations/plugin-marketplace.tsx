import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { useLinkFavicon } from "@rakazo/chat-ui/web";
import type {
  CapabilityInstall,
  McpServer,
  PluginMarketplaceEntry,
  PluginPreview,
} from "@rakazo/contracts";
import { PluginPreviewSchema } from "@rakazo/contracts";
import { Button, Disclosure, Spinner } from "@rakazo/ui-web";
import { ArrowUpRight, Box, Check, ChevronLeft, Plug } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { connectMcpOauth } from "../../lib/mcp-connect";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

export type PluginSelection = {
  source: string;
  installedSource: string;
  name: string;
  description?: string;
  logo?: string | null;
  site?: string | null;
};

export function pluginSelection(entry: PluginMarketplaceEntry): PluginSelection {
  return {
    source: entry.source,
    installedSource: entry.installedSource,
    name: entry.displayName,
    description: entry.description,
    logo: entry.logo,
    site: pluginSite(entry),
  };
}

/** GitHub homepages would give every plugin the same mark, so they never stand in for a site. */
function pluginSite(entry: Pick<PluginMarketplaceEntry, "homepage" | "domains">): string | null {
  const domain = entry.domains[0]?.replace(/^https?:\/\//, "");
  if (domain) return `https://${domain}`;
  try {
    return entry.homepage && !new URL(entry.homepage).hostname.endsWith("github.com")
      ? entry.homepage
      : null;
  } catch {
    return null;
  }
}

export function PluginLogo({
  name,
  logo,
  site,
  large = false,
}: {
  name: string;
  logo?: string | null;
  site?: string | null;
  large?: boolean;
}) {
  const [logoFailed, setLogoFailed] = useState(false);
  const useLogo = Boolean(logo) && !logoFailed;
  const favicon = useLinkFavicon(useLogo ? "" : (site ?? ""));
  const src = useLogo ? logo : favicon.icon;
  const box = large ? "h-14 w-14 rounded-2xl text-xl" : "h-10 w-10 rounded-xl text-sm";
  return src ? (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => (useLogo ? setLogoFailed(true) : favicon.unusable())}
      className={`${box} shrink-0 border border-border/60 bg-favicon-plate object-contain p-1.5`}
    />
  ) : (
    <div
      className={`${box} grid shrink-0 place-items-center border border-border/60 bg-favicon-plate font-semibold text-foreground`}
    >
      {name[0]?.toUpperCase()}
    </div>
  );
}

/** Signed in, or answering without a sign-in. */
export function mcpServerReady(server: McpServer) {
  return server.oauthStatus === "connected" || server.health.status === "ok";
}

export function PluginRow({
  name,
  description,
  logo,
  site,
  installed,
  onOpen,
}: {
  name: string;
  description: string;
  logo?: string | null;
  site?: string | null;
  installed: boolean;
  onOpen: () => void;
}) {
  return (
    <div
      data-testid="plugin-row"
      className="flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2 hover:bg-accent/60"
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 text-start focus-visible:outline-none"
      >
        <PluginLogo name={name} logo={logo} site={site} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-medium text-foreground">{name}</span>
          {description ? (
            <span className="block truncate text-[13px] text-muted-foreground">{description}</span>
          ) : null}
        </span>
      </button>
      <Button type="button" variant="secondary" size="sm" onClick={onOpen}>
        {installed ? <Trans>Added</Trans> : <Trans>Add</Trans>}
      </Button>
    </div>
  );
}

function sourceHref(source: string, sha: string | undefined) {
  const [repo, subdir] = source.split("#");
  return subdir ? `${repo}/tree/${sha ?? "HEAD"}/${subdir}` : repo;
}

const SKILLS_SHOWN = 5;

export function PluginDetail({
  selection,
  installs,
  servers: allServers,
  assigned,
  activeBotId,
  onBack,
  onChanged,
}: {
  selection: PluginSelection;
  installs: CapabilityInstall[];
  servers: McpServer[];
  assigned: Set<string>;
  activeBotId?: string;
  onBack: () => void;
  onChanged: () => Promise<unknown>;
}) {
  const { t } = useLingui();
  const [preview, setPreview] = useState<PluginPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [allSkills, setAllSkills] = useState(false);
  const [noAuth, setNoAuth] = useState(new Set<string>());
  const [attempt, setAttempt] = useState(0);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // A pasted URL can differ from the normalized source the install is saved under.
  const install = installs.find(
    (row) =>
      row.kind === "plugin" &&
      (row.source === selection.installedSource || row.source === preview?.installedSource),
  );
  const servers = install ? allServers.filter((server) => server.installId === install.id) : [];
  const parsed = install ? PluginPreviewSchema.safeParse(install.config) : null;
  const detail = parsed?.success ? parsed.data : preview;
  const installed = Boolean(install);

  useEffect(() => {
    if (installed) return;
    let cancelled = false;
    setPreview(null);
    setError(null);
    setPreviewLoading(true);
    rpc.capabilities
      .pluginPreview({ source: selection.source })
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((err) => {
        if (!cancelled) setError(errorText(err, t`Could not preview plugin`));
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selection.source, installed, attempt]);

  async function run(key: string, action: () => Promise<unknown>, failure: string) {
    setPending(key);
    setError(null);
    try {
      await action();
    } catch (err) {
      if (live.current) setError(errorText(err, failure));
    } finally {
      if (live.current) setPending(null);
    }
  }

  const add = () =>
    preview &&
    run(
      "install",
      async () => {
        await rpc.capabilities.install({
          kind: "plugin",
          name: preview.name,
          source: preview.pinnedSource ?? selection.source,
          pluginDigest: preview.digest,
          config: {},
        });
        await onChanged();
      },
      t`Could not install plugin`,
    );

  const signIn = (server: McpServer) =>
    run(
      server.id,
      async () => {
        const result = await connectMcpOauth(server.id);
        if (!live.current) return;
        if (result === "authorization_not_requested")
          setNoAuth((current) => new Set([...current, server.id]));
        if (result === "cancelled") setError(t`Sign-in cancelled. Try again.`);
        await onChanged();
      },
      t`Could not sign in`,
    );

  const enable = (server: McpServer) =>
    activeBotId &&
    run(
      server.id,
      async () => {
        await rpc.mcp.assignments.approve({ botId: activeBotId, serverId: server.id });
        await onChanged();
      },
      t`Could not enable tools`,
    );

  const remove = () =>
    install &&
    run(
      "remove",
      async () => {
        await rpc.capabilities.remove({ id: install.id });
        await onChanged();
        if (live.current) onBack();
      },
      t`Could not remove plugin`,
    );

  const prefix = `${detail?.name ?? ""}: `;
  const skills = detail?.skills ?? [];
  const shownSkills = allSkills ? skills : skills.slice(0, SKILLS_SHOWN);
  const appCount = installed ? servers.length : (detail?.mcpServers.length ?? 0);
  const busy = Boolean(pending);

  return (
    <div data-testid="plugin-detail" className="space-y-7">
      <div className="flex items-start gap-4">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="mt-3.5 -ms-2 text-muted-foreground"
          aria-label={t`Back`}
          disabled={busy}
          onClick={onBack}
        >
          <ChevronLeft />
        </Button>
        <PluginLogo name={selection.name} logo={selection.logo} site={selection.site} large />
        <div className="min-w-0 flex-1 pt-1">
          <h2 className="truncate text-[20px] font-semibold text-foreground">{selection.name}</h2>
          <a
            href={sourceHref(selection.installedSource, detail?.resolvedSha)}
            target="_blank"
            rel="noreferrer"
            title={detail ? `${selection.installedSource}@${detail.resolvedSha}` : undefined}
            className="inline-flex items-center gap-1 text-[13.5px] text-muted-foreground hover:text-foreground"
          >
            <Trans>View source</Trans>
            <ArrowUpRight size={14} />
          </a>
        </div>
        <div className="flex shrink-0 gap-2 pt-2">
          {installed ? (
            confirmRemove ? (
              <>
                <Button variant="ghost" disabled={busy} onClick={() => setConfirmRemove(false)}>
                  <Trans>Cancel</Trans>
                </Button>
                <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
                  {pending === "remove" ? <Trans>Removing…</Trans> : <Trans>Confirm removal</Trans>}
                </Button>
              </>
            ) : (
              <Button variant="secondary" disabled={busy} onClick={() => setConfirmRemove(true)}>
                <Trans>Remove</Trans>
              </Button>
            )
          ) : (
            <Button
              size="lg"
              className="px-5"
              disabled={busy || !preview || (!preview.skills.length && !preview.mcpServers.length)}
              onClick={() => void add()}
            >
              {pending === "install" ? <Trans>Adding…</Trans> : <Trans>Add</Trans>}
            </Button>
          )}
        </div>
      </div>

      {detail?.description || selection.description ? (
        <p className="text-[15px] leading-6 text-muted-foreground">
          {detail?.description || selection.description}
        </p>
      ) : null}

      {error ? (
        <div role="alert" className="flex items-center gap-3 text-sm text-destructive">
          {error}
          {!installed && !preview && !previewLoading ? (
            <Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>
              <Trans>Retry</Trans>
            </Button>
          ) : null}
        </div>
      ) : null}

      {previewLoading ? (
        <div className="grid place-items-center py-10">
          <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
        </div>
      ) : null}

      {appCount ? (
        <section>
          <h3 className="mb-2 flex gap-2 px-1 text-[14px] font-medium text-foreground">
            <Trans>Apps</Trans>
            <span className="text-muted-foreground">{appCount}</span>
          </h3>
          <ul className="divide-y divide-border/60 rounded-xl border border-border/70">
            {installed
              ? servers.map((server) => (
                  <li
                    key={server.id}
                    aria-label={server.name}
                    className="flex items-center gap-3 px-4 py-3"
                  >
                    <Plug size={16} className="shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14.5px] font-medium">
                        {server.name.startsWith(prefix)
                          ? server.name.slice(prefix.length)
                          : server.name}
                      </span>
                      <span className="block truncate text-[12.5px] text-muted-foreground">
                        {server.endpoint}
                      </span>
                    </span>
                    {mcpServerReady(server) ? (
                      <Check role="img" aria-label={t`Connected`} className="size-4 text-success" />
                    ) : noAuth.has(server.id) ? null : (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void signIn(server)}
                      >
                        {pending === server.id ? (
                          <Trans>Connecting…</Trans>
                        ) : server.oauthStatus === "reconnect" ? (
                          <Trans>Reconnect</Trans>
                        ) : (
                          <Trans>Sign in</Trans>
                        )}
                      </Button>
                    )}
                    {activeBotId ? (
                      assigned.has(server.id) ? (
                        <span className="text-[13px] text-muted-foreground">
                          <Trans>In this bot</Trans>
                        </span>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          onClick={() => void enable(server)}
                        >
                          <Trans>Use in this bot</Trans>
                        </Button>
                      )
                    ) : null}
                  </li>
                ))
              : detail?.mcpServers.map((server) => (
                  <li key={server.name} className="flex items-center gap-3 px-4 py-3">
                    <Plug size={16} className="shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14.5px] font-medium">
                        {server.name}
                      </span>
                      <span className="block truncate text-[12.5px] text-muted-foreground">
                        {server.endpoint}
                      </span>
                    </span>
                  </li>
                ))}
          </ul>
        </section>
      ) : null}

      {skills.length ? (
        <section>
          <h3 className="mb-2 flex gap-2 px-1 text-[14px] font-medium text-foreground">
            <Trans>Skills</Trans>
            <span className="text-muted-foreground">{skills.length}</span>
          </h3>
          <ul className="divide-y divide-border/60 rounded-xl border border-border/70">
            {shownSkills.map((skill) => (
              <li key={skill.name} className="flex items-center gap-3 px-4 py-3">
                <Box size={16} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14.5px] font-medium">{skill.name}</span>
                  <span className="block truncate text-[12.5px] text-muted-foreground">
                    {skill.description}
                  </span>
                </span>
              </li>
            ))}
            {skills.length > shownSkills.length ? (
              <li className="flex justify-end px-2 py-1.5">
                <Button variant="text" size="sm" onClick={() => setAllSkills(true)}>
                  <Plural value={skills.length - shownSkills.length} one="# more" other="# more" />
                </Button>
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}

      {detail?.skipped.length ? (
        <Disclosure
          summary={
            <Plural
              value={detail.skipped.length}
              one="# part not added"
              other="# parts not added"
            />
          }
          summaryClassName="px-1 text-[13px] text-muted-foreground"
        >
          <ul className="mt-2 space-y-1.5 px-1 text-[13px] text-muted-foreground">
            {detail.skipped.map((entry, i) => (
              <li key={`${entry.kind}:${entry.name}:${i}`}>
                <span className="font-medium text-foreground">{entry.name}</span> {entry.reason}
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
    </div>
  );
}
