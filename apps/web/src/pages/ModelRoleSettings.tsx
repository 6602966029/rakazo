import { Trans, useLingui } from "@lingui/react/macro";
import type {
  ModelBackupChoice,
  ModelCatalogEntry,
  ModelCredential,
  ModelRole,
  ModelRoleSettings as ModelRoleSettingsValue,
  ThinkingLevel,
} from "@rakazo/contracts";
import {
  backupChoiceKey,
  canonicalPiProviderId,
  connectedBackupOptions,
  MAX_MODEL_BACKUPS,
} from "@rakazo/contracts";
import { createModelRoleSettings } from "@rakazo/core";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Spinner,
} from "@rakazo/ui-web";
import { GripVertical, MoreHorizontal, Plus } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { thinkingLevelLabel } from "../lib/model-catalog";
import { useSpaceRpc } from "../lib/space-rpc";
import type { ConnectableProvider } from "./model-settings/role-model-picker";
import { RoleModelPicker } from "./model-settings/role-model-picker";

export type ModelRoleConnectIntent = {
  /** Only the main role's first slot replaces the space's default model on connect. */
  makeDefault: boolean;
  onConnected: (choice: ModelBackupChoice) => Promise<void>;
};

type Props = {
  userId: string;
  spaceId: string;
  credentials: ModelCredential[];
  modelRole?: ModelRole;
  title: string;
  /** What runs when the first slot is empty. */
  defaultLabel: string;
  providers: ConnectableProvider[];
  /** Connection-aware names, such as "Claude subscription" or a compatible server's host. */
  providerLabel: (provider: string) => string;
  onConnect: (provider: ConnectableProvider, intent: ModelRoleConnectIntent) => void;
  onManage: (provider: string) => void;
  /** Effort for the first slot, when its model can think. */
  thinking?: {
    levels: ThinkingLevel[];
    value: ThinkingLevel | null;
    onChange: (level: ThinkingLevel | null) => void;
  };
  onChanged?: () => void;
};

const sameChoice = (left: ModelBackupChoice, right: ModelBackupChoice) =>
  backupChoiceKey(left) === backupChoiceKey(right);

/** One ordered list per model purpose: the first row runs, the rest take over in order. */
export function ModelRoleSettings({
  userId,
  spaceId,
  credentials,
  modelRole: role = "main",
  title,
  defaultLabel,
  providers,
  providerLabel,
  onConnect,
  onManage,
  thinking,
  onChanged,
}: Props) {
  const rpc = useSpaceRpc();
  const { t } = useLingui();
  const controller = useMemo(
    () =>
      createModelRoleSettings(
        {
          load: () => rpc.models.role({ role, expectedUserId: userId }, { context: { spaceId } }),
          catalog: () =>
            rpc.models.forRole({ role, expectedUserId: userId }, { context: { spaceId } }),
          save: (patch) =>
            rpc.models.setRole(
              { role, expectedUserId: userId, ...patch },
              { context: { spaceId } },
            ),
        },
        JSON.stringify([window.location.origin, userId, spaceId, role]),
      ),
    [rpc, userId, spaceId, role],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const [dragging, setDragging] = useState<number | null>(null);
  useEffect(() => {
    void controller.load();
  }, [controller, credentials]);

  const settings = state.settings;
  const primary = settings?.primary ?? null;
  const backups = settings?.backups ?? [];
  const rows = primary ? [primary, ...backups] : backups;
  const entryFor = (choice: ModelBackupChoice) =>
    state.catalog.find(
      (entry) =>
        canonicalPiProviderId(entry.provider) === canonicalPiProviderId(choice.provider) &&
        entry.id === choice.modelId,
    );
  const connected = new Set(credentials.map((entry) => canonicalPiProviderId(entry.provider)));
  const options: ModelCatalogEntry[] = connectedBackupOptions(state.catalog, credentials).map(
    (choice) => ({
      ...(entryFor(choice) ?? {
        provider: choice.provider,
        id: choice.modelId,
        label: choice.label,
        billing: "",
      }),
      providerName: providerLabel(choice.provider),
    }),
  );
  // The main model is chosen through a personal connection, so deployment-managed
  // models can only back it up.
  const primaryOptions =
    role === "main"
      ? options.filter((entry) => connected.has(canonicalPiProviderId(entry.provider)))
      : options;
  const providerName = (choice: ModelBackupChoice) => providerLabel(choice.provider);
  const modelLabel = (choice: ModelBackupChoice) => entryFor(choice)?.label ?? choice.modelId;
  // Saves wait for a reload, so only the first load needs to hold the controls.
  const busy = !settings;

  async function save(
    update: (current: ModelRoleSettingsValue) => Partial<ModelRoleSettingsValue>,
  ) {
    await controller.save(update);
    onChanged?.();
  }
  // The main model needs a personal connection; deployment-managed models only back it up.
  const canLead = (choice: ModelBackupChoice) =>
    role !== "main" || connected.has(canonicalPiProviderId(choice.provider));
  // The first row is the primary; moving a fallback there promotes it. When the main model
  // goes, the first fallback that can lead takes over, or the deployment's own model runs.
  const commit = (next: ModelBackupChoice[]) =>
    save((current) => {
      if (!current.primary) return { backups: next };
      const lead = next.findIndex(canLead);
      return lead < 0
        ? { primary: null, backups: next }
        : { primary: next[lead]!, backups: next.filter((_, index) => index !== lead) };
    });
  const canMove = (index: number, target: number) =>
    target >= 0 &&
    target < rows.length &&
    target !== index &&
    !(primary && target === 0 && !canLead(rows[index]!)) &&
    !(primary && index === 0 && !canLead(rows[1]!));
  const place = (slot: number | "add", choice: ModelBackupChoice) =>
    save((current) => {
      const list = current.primary ? [current.primary, ...current.backups] : current.backups;
      if (slot === "add")
        return listPatch(current, [...list.filter((c) => !sameChoice(c, choice)), choice]);
      const next = list.map((item, index) => (index === slot ? choice : item));
      return listPatch(
        current,
        next.filter((item, index) => index === slot || !sameChoice(item, choice)),
      );
    });
  const setPrimary = (choice: ModelBackupChoice | null) =>
    save((current) => ({
      primary: choice,
      backups: choice
        ? current.backups.filter((item) => !sameChoice(item, choice))
        : current.backups,
    }));
  const move = (index: number, target: number) => {
    if (!canMove(index, target)) return;
    const next = [...rows];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item!);
    void commit(next);
  };
  const remove = (index: number) => void commit(rows.filter((_, item) => item !== index));
  const connectFor = (slot: "primary" | number | "add") => (provider: ConnectableProvider) =>
    onConnect(provider, {
      makeDefault: role === "main" && slot === "primary",
      onConnected: async (choice) => {
        // A main-model connection is already the default once it saves.
        if (role === "main" && slot === "primary") {
          await controller.load();
          onChanged?.();
        } else if (slot === "primary") await setPrimary(choice);
        else await place(slot, choice);
      },
    });

  const canAdd = backups.length < MAX_MODEL_BACKUPS;
  const rowClass = "flex min-h-[52px] items-center gap-2.5 py-2 ps-2 pe-2";
  const number = (index: number) => (
    <span className="grid size-5 shrink-0 place-items-center rounded-md bg-muted text-[12px] text-muted-foreground">
      {index + 1}
    </span>
  );
  const pickerTrigger = (label: string, sub?: string) => (
    <button
      type="button"
      className="flex min-w-0 flex-1 items-baseline gap-1.5 rounded-md py-1 text-start outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <span className="truncate text-[15px] text-foreground">{label}</span>
      {sub ? <span className="truncate text-[13px] text-muted-foreground">· {sub}</span> : null}
    </button>
  );

  return (
    <section className="mb-8" data-testid={`model-role-${role}`}>
      <h3 className="mb-2.5 text-[15px] font-medium text-foreground">{title}</h3>
      <ol className="divide-y divide-border rounded-xl border border-border">
        {primary ? null : (
          <li className={`${rowClass} ps-8`} data-testid="model-role-default">
            {number(0)}
            <RoleModelPicker
              trigger={pickerTrigger(defaultLabel)}
              label={t`Change ${title}`}
              options={primaryOptions}
              defaultOption={role === "main" ? undefined : defaultLabel}
              providers={providers}
              disabled={busy}
              onPick={(option) =>
                option ? void setPrimary({ provider: option.provider, modelId: option.id }) : null
              }
              onConnect={connectFor("primary")}
            />
          </li>
        )}
        {rows.map((choice, index) => {
          const isPrimary = Boolean(primary) && index === 0;
          const name = modelLabel(choice);
          const offset = primary ? 0 : 1;
          const manageable = connected.has(canonicalPiProviderId(choice.provider));
          return (
            <li
              key={backupChoiceKey(choice)}
              className={`${rowClass} ${dragging === index ? "opacity-50" : ""}`}
              data-testid={`model-role-row-${index + offset + 1}`}
              draggable={rows.length > 1 && !busy}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                setDragging(index);
              }}
              onDragEnd={() => setDragging(null)}
              onDragOver={(event) => {
                if (dragging !== null) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragging !== null) move(dragging, index);
                setDragging(null);
              }}
            >
              <GripVertical
                aria-hidden
                className={`size-3.5 shrink-0 text-muted-foreground/60 ${rows.length > 1 ? "cursor-grab" : "invisible"}`}
              />
              {number(index + offset)}
              <RoleModelPicker
                trigger={pickerTrigger(name, providerName(choice))}
                label={t`Change ${name}`}
                options={isPrimary ? primaryOptions : options}
                defaultOption={isPrimary && role !== "main" ? defaultLabel : undefined}
                providers={providers}
                disabled={busy}
                onPick={(option) =>
                  option
                    ? void (isPrimary
                        ? setPrimary({ provider: option.provider, modelId: option.id })
                        : place(index, { provider: option.provider, modelId: option.id }))
                    : void setPrimary(null)
                }
                onConnect={connectFor(isPrimary ? "primary" : index)}
              />
              {isPrimary && thinking?.value ? (
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[12.5px] text-muted-foreground">
                  <Trans>Thinking: {thinkingLevelLabel(thinking.value)}</Trans>
                </span>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0 text-muted-foreground"
                      aria-label={t`${name} options`}
                      disabled={busy}
                    />
                  }
                >
                  <MoreHorizontal />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[200px]">
                  {isPrimary && thinking?.levels.length ? (
                    <>
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                          <Trans>Thinking</Trans>
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                          <DropdownMenuRadioGroup
                            value={thinking.value ?? ""}
                            onValueChange={(value) =>
                              thinking.onChange((value || null) as ThinkingLevel | null)
                            }
                          >
                            <DropdownMenuRadioItem value="">
                              <Trans>Default</Trans>
                            </DropdownMenuRadioItem>
                            {thinking.levels.map((level) => (
                              <DropdownMenuRadioItem key={level} value={level}>
                                {thinkingLevelLabel(level)}
                              </DropdownMenuRadioItem>
                            ))}
                          </DropdownMenuRadioGroup>
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                      <DropdownMenuSeparator />
                    </>
                  ) : null}
                  {rows.length > 1 ? (
                    <>
                      <DropdownMenuItem
                        disabled={!canMove(index, index - 1)}
                        onClick={() => move(index, index - 1)}
                      >
                        <Trans>Move up</Trans>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={!canMove(index, index + 1)}
                        onClick={() => move(index, index + 1)}
                      >
                        <Trans>Move down</Trans>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                    </>
                  ) : null}
                  {manageable ? (
                    <DropdownMenuItem onClick={() => onManage(choice.provider)}>
                      <Trans>Manage {providerName(choice)}</Trans>
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem variant="destructive" onClick={() => remove(index)}>
                    <Trans>Remove</Trans>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          );
        })}
        {canAdd ? (
          <li>
            <RoleModelPicker
              trigger={
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-b-xl px-3 py-3 text-start text-[14px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <Plus className="size-4" aria-hidden />
                  <Trans>Add fallback</Trans>
                </button>
              }
              label={t`Add fallback`}
              options={options.filter((option) =>
                rows.every(
                  (row) => !sameChoice(row, { provider: option.provider, modelId: option.id }),
                ),
              )}
              providers={providers}
              disabled={busy}
              onPick={(option) =>
                option ? void place("add", { provider: option.provider, modelId: option.id }) : null
              }
              onConnect={connectFor("add")}
            />
          </li>
        ) : null}
      </ol>
      {state.busy && !settings ? (
        <Spinner className="mt-3" aria-label={t`Loading model catalog…`} />
      ) : null}
      {state.error ? (
        <div role="alert" className="mt-2 text-sm text-destructive">
          {state.error}
          <Button variant="ghost" disabled={state.busy} onClick={() => void controller.load()}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function listPatch(
  current: ModelRoleSettingsValue,
  list: ModelBackupChoice[],
): Partial<ModelRoleSettingsValue> {
  return current.primary ? { primary: list[0] ?? null, backups: list.slice(1) } : { backups: list };
}
