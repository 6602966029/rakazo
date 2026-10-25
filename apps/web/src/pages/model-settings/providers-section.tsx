import { Trans, useLingui } from "@lingui/react/macro";
import { MAX_MODEL_CONNECTION_LABEL, OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import {
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@rakazo/ui-web";
import { MoreHorizontal, Plus } from "lucide-react";
import { useId, useRef, useState } from "react";
import type { ModelCredential } from "../../lib/model-auth";
import { useSpaceRpc } from "../../lib/space-rpc";
import { errorText } from "../../lib/user-error";
import type { ConnectableProvider } from "./role-model-picker";

/** Every connection the member has, with the way to add another, even for a connected provider. */
export function ProvidersSection({
  credentials,
  providers,
  name: nameOf,
  disabled,
  onAdd,
  onOpen,
  onDisconnect,
  onRenamed,
}: {
  credentials: ModelCredential[];
  /** Every provider that can be connected, connected ones included. */
  providers: ConnectableProvider[];
  /** A connection's name, such as "OpenAI" or "OpenAI · Work". */
  name: (credential: ModelCredential) => string;
  disabled?: boolean;
  onAdd: (provider: ConnectableProvider) => void;
  onOpen: (credential: ModelCredential) => void;
  onDisconnect: (credential: ModelCredential) => void;
  onRenamed: () => void;
}) {
  const { t } = useLingui();
  const [renaming, setRenaming] = useState<ModelCredential | null>(null);
  return (
    <section className="mb-8" data-testid="model-providers">
      <h3 className="mb-2.5 text-[15px] font-medium text-foreground">
        <Trans>Providers</Trans>
      </h3>
      <ul className="divide-y divide-border rounded-xl border border-border">
        {[...credentials]
          // Saving a key reorders the account's connections; this list stays put.
          .sort((left, right) => nameOf(left).localeCompare(nameOf(right)))
          .map((credential) => {
            const name = nameOf(credential);
            return (
              <li
                key={credential.id}
                className="flex min-h-[52px] items-center gap-2.5 py-2 ps-3 pe-2"
                data-testid={`model-provider-${credential.id}`}
              >
                <span className="min-w-0 flex-1 truncate text-[15px] text-foreground">{name}</span>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="shrink-0 text-muted-foreground"
                        aria-label={t`${name} options`}
                        disabled={disabled}
                      />
                    }
                  >
                    <MoreHorizontal />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[200px]">
                    <DropdownMenuItem onClick={() => setRenaming(credential)}>
                      <Trans>Rename</Trans>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onOpen(credential)}>
                      {credential.authKind === "oauth" ? (
                        <Trans>Sign in again</Trans>
                      ) : credential.provider === OPENAI_COMPATIBLE_PROVIDER_ID ? (
                        <Trans>Edit</Trans>
                      ) : (
                        <Trans>Replace key</Trans>
                      )}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => onDisconnect(credential)}
                    >
                      <Trans>Disconnect</Trans>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            );
          })}
        <li>
          <AddProvider providers={providers} disabled={disabled} onPick={onAdd} />
        </li>
      </ul>
      {renaming ? (
        <RenameConnectionDialog
          credential={renaming}
          name={renaming.label}
          onClose={() => setRenaming(null)}
          onRenamed={() => {
            setRenaming(null);
            onRenamed();
          }}
        />
      ) : null}
    </section>
  );
}

function AddProvider({
  providers,
  disabled,
  onPick,
}: {
  providers: ConnectableProvider[];
  disabled?: boolean;
  onPick: (provider: ConnectableProvider) => void;
}) {
  const { t } = useLingui();
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const matching = providers.filter((provider) => provider.name.toLowerCase().includes(needle));
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setQuery("");
        setOpen(next);
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        render={
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-b-xl px-3 py-3 text-start text-[14px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <Plus className="size-4" aria-hidden />
            <Trans>Add provider</Trans>
          </button>
        }
      />
      <PopoverContent
        align="start"
        sideOffset={6}
        initialFocus={searchRef}
        className="w-[min(360px,var(--available-width))] gap-0 overflow-hidden p-0 motion-reduce:animate-none"
      >
        <Command label={t`Add provider`} shouldFilter={false} loop>
          <CommandInput
            ref={searchRef}
            value={query}
            onValueChange={setQuery}
            aria-label={t`Add provider`}
            placeholder={t`Search`}
          />
          <CommandList className="rk-scroll max-h-80">
            <CommandEmpty>
              <Trans>No results</Trans>
            </CommandEmpty>
            <CommandGroup>
              {matching.map((provider) => (
                <CommandItem
                  key={`${provider.id}:${provider.baseUrl ?? ""}`}
                  value={`${provider.id}:${provider.baseUrl ?? ""}`}
                  onSelect={() => {
                    setOpen(false);
                    onPick(provider);
                  }}
                >
                  <span className="min-w-0 truncate">{provider.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function RenameConnectionDialog({
  credential,
  name: initial,
  onClose,
  onRenamed,
}: {
  credential: ModelCredential;
  name: string;
  onClose: () => void;
  onRenamed: () => void;
}) {
  const rpc = useSpaceRpc();
  const { t } = useLingui();
  const nameId = useId();
  const [name, setName] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !saving) onClose();
      }}
    >
      <DialogContent showCloseButton={false} aria-describedby={undefined}>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            if (!trimmed || saving) return;
            setSaving(true);
            setError(null);
            rpc.models
              .rename({ credentialId: credential.id, label: trimmed })
              .then(onRenamed, (err: unknown) => {
                setError(errorText(err, t`Could not rename connection`));
                setSaving(false);
              });
          }}
        >
          <DialogHeader>
            <DialogTitle>
              <Trans>Rename</Trans>
            </DialogTitle>
          </DialogHeader>
          <label htmlFor={nameId} className="block text-[13.5px] text-foreground/75">
            <Trans>Name</Trans>
            <Input
              id={nameId}
              maxLength={MAX_MODEL_CONNECTION_LABEL}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mt-2"
              autoFocus
            />
          </label>
          {error ? <p className="text-[13.5px] text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
              <Trans>Cancel</Trans>
            </Button>
            <Button type="submit" disabled={saving || !trimmed || trimmed === initial}>
              {saving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
