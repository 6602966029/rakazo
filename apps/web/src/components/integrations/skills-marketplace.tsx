import { Trans, useLingui } from "@lingui/react/macro";
import type { PluginMarketplaceEntry } from "@rakazo/contracts";
import { matchesPluginQuery } from "@rakazo/core";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Field,
  FieldLabel,
  Input,
  Spinner,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, X } from "lucide-react";
import { useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import type { PluginSelection } from "./plugin-marketplace";
import { PluginDetail, PluginRow, pluginSelection } from "./plugin-marketplace";

const NO_ENTRIES: PluginMarketplaceEntry[] = [];
const NO_SERVERS: never[] = [];
const NOT_ASSIGNED = new Set<string>();

/** Skill packs from the plugin catalogs: plugins with nothing to connect, only skills. */
export function SkillsMarketplaceDialog({ onClose }: { onClose: () => void }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<PluginSelection | null>(null);
  const [importing, setImporting] = useState(false);
  const [gitSource, setGitSource] = useState("");
  const catalog = useQuery(
    queries.marketplace.catalog.queryOptions({ input: { query: "" }, staleTime: 60_000 }),
  );
  const installs = useQuery(queries.capabilities.list.queryOptions());
  const packs = (catalog.data?.entries ?? NO_ENTRIES).filter(
    (entry) => !entry.hasConnector && matchesPluginQuery(entry, query),
  );
  const pluginInstalls = (installs.data ?? []).filter((row) => row.kind === "plugin");

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queries.capabilities.key() }),
      queryClient.invalidateQueries({ queryKey: queries.agentSkills.key() }),
    ]);
  }

  function back(onBack: () => void) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="-ms-2 text-muted-foreground"
        aria-label={t`Back`}
        onClick={onBack}
      >
        <ChevronLeft />
      </Button>
    );
  }

  function content() {
    if (selection)
      return (
        <PluginDetail
          key={selection.installedSource}
          selection={selection}
          installs={pluginInstalls}
          servers={NO_SERVERS}
          assigned={NOT_ASSIGNED}
          onBack={() => setSelection(null)}
          onChanged={refresh}
        />
      );
    if (importing)
      return (
        <div data-testid="skills-git-import" className="max-w-xl space-y-6">
          <div className="flex items-center gap-2">
            {back(() => setImporting(false))}
            <h2 className="text-[17px] font-medium text-foreground">
              <Trans>From GitHub</Trans>
            </h2>
          </div>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              const source = gitSource.trim().replace(/\/$/, "");
              if (!source) return;
              setSelection({
                source,
                installedSource: source,
                name: source.split("/").pop() ?? source,
              });
            }}
          >
            <Field>
              <FieldLabel htmlFor="skills-git-url">
                <Trans>Plugin GitHub URL</Trans>
              </FieldLabel>
              <Input
                id="skills-git-url"
                value={gitSource}
                onChange={(event) => setGitSource(event.target.value)}
                placeholder="https://github.com/owner/plugin"
                maxLength={2048}
                autoFocus
              />
            </Field>
            <Button type="submit" disabled={!gitSource.trim()}>
              <Trans>Preview</Trans>
            </Button>
          </form>
        </div>
      );
    return (
      <>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={t`Search skills`}
          placeholder={t`Search skills`}
          maxLength={200}
          className="mb-5 h-11 rounded-xl"
        />
        {catalog.isPending ? (
          <div className="grid place-items-center py-10">
            <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
          </div>
        ) : null}
        {catalog.error || catalog.data?.unavailableRegistries.length ? (
          <div role="alert" className="mb-4 flex items-center gap-3 text-sm text-muted-foreground">
            <Trans>Some plugins could not be loaded.</Trans>
            <Button variant="outline" size="sm" onClick={() => void catalog.refetch()}>
              <Trans>Retry</Trans>
            </Button>
          </div>
        ) : null}
        <div data-testid="skill-packs" className="grid grid-cols-2 gap-2">
          {packs.map((entry) => {
            const pack = pluginSelection(entry);
            return (
              <PluginRow
                key={entry.id}
                name={entry.displayName}
                description={entry.description}
                logo={entry.logo}
                site={pack.site}
                installed={pluginInstalls.some((row) => row.source === entry.installedSource)}
                onOpen={() => setSelection(pack)}
              />
            );
          })}
        </div>
      </>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex h-[680px] max-h-[calc(100%-2rem)] w-[920px] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-2xl bg-card p-0 sm:max-w-[920px]"
      >
        <DialogHeader className="flex-row items-start justify-between px-8 pt-7">
          <DialogTitle className="text-heading2 text-foreground">
            <Trans>Skills</Trans>
          </DialogTitle>
          <div className="flex items-center gap-2">
            {!selection && !importing ? (
              <Button variant="ghost" size="sm" onClick={() => setImporting(true)}>
                <Trans>From GitHub</Trans>
              </Button>
            ) : null}
            <DialogClose
              render={<Button variant="ghost" size="icon-sm" aria-label={t`Close skills`} />}
            >
              <X />
            </DialogClose>
          </div>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-8 pt-5 pb-8">{content()}</div>
      </DialogContent>
    </Dialog>
  );
}
