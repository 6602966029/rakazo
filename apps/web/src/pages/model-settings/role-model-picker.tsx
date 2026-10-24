import { Trans, useLingui } from "@lingui/react/macro";
import { filterModelCatalog } from "@rakazo/core";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@rakazo/ui-web";
import { ChevronRight } from "lucide-react";
import type { ReactElement } from "react";
import { useMemo, useRef, useState } from "react";
import type { ModelCatalogEntry } from "../../lib/model-auth";

/** `baseUrl` presets an OpenAI-compatible server, such as Ollama Cloud. */
export type ConnectableProvider = { id: string; name: string; baseUrl?: string };

/**
 * One picker for every model a role can use: connected models pick directly, and
 * providers that still need a connection hand off to the connect dialog.
 */
export function RoleModelPicker({
  trigger,
  label,
  options,
  providers,
  defaultOption,
  disabled,
  onPick,
  onConnect,
}: {
  trigger: ReactElement;
  label: string;
  options: ModelCatalogEntry[];
  providers: ConnectableProvider[];
  /** Clears the slot back to the deployment's own choice. */
  defaultOption?: string;
  disabled?: boolean;
  onPick: (option: ModelCatalogEntry | null) => void;
  onConnect: (provider: ConnectableProvider) => void;
}) {
  const { t } = useLingui();
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const groups = useMemo(() => {
    const grouped = new Map<string, ModelCatalogEntry[]>();
    for (const option of filterModelCatalog(options, query)) {
      const name = option.providerName ?? option.provider;
      grouped.set(name, [...(grouped.get(name) ?? []), option]);
    }
    return [...grouped];
  }, [options, query]);
  const needle = query.trim().toLowerCase();
  const matchingProviders = providers.filter((provider) =>
    provider.name.toLowerCase().includes(needle),
  );
  const close = () => setOpen(false);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setQuery("");
        setOpen(next);
      }}
    >
      <PopoverTrigger render={trigger} aria-label={label} disabled={disabled} />
      <PopoverContent
        align="start"
        sideOffset={6}
        initialFocus={searchRef}
        className="w-[min(360px,var(--available-width))] gap-0 overflow-hidden p-0 motion-reduce:animate-none"
      >
        <Command label={label} shouldFilter={false} loop>
          <CommandInput
            ref={searchRef}
            value={query}
            onValueChange={setQuery}
            aria-label={t`Search models`}
            placeholder={t`Search`}
          />
          <CommandList label={t`Model options`} className="rk-scroll max-h-80">
            <CommandEmpty>
              <Trans>No matching models</Trans>
            </CommandEmpty>
            {defaultOption && !needle ? (
              <CommandGroup>
                <CommandItem
                  value="default"
                  onSelect={() => {
                    onPick(null);
                    close();
                  }}
                >
                  {defaultOption}
                </CommandItem>
              </CommandGroup>
            ) : null}
            {groups.map(([name, entries]) => (
              <CommandGroup key={name} heading={name}>
                {entries.map((option) => (
                  <CommandItem
                    key={`${option.provider}:${option.id}`}
                    value={`${option.provider}:${option.id}`}
                    onSelect={() => {
                      onPick(option);
                      close();
                    }}
                  >
                    <span className="min-w-0 truncate">{option.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
            {matchingProviders.length ? (
              <CommandGroup heading={t`Not connected`}>
                {matchingProviders.map((provider) => (
                  <CommandItem
                    key={`${provider.id}:${provider.baseUrl ?? ""}`}
                    value={`connect:${provider.id}:${provider.baseUrl ?? ""}`}
                    onSelect={() => {
                      close();
                      onConnect(provider);
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{provider.name}</span>
                    <ChevronRight className="ml-auto text-muted-foreground" aria-hidden />
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
