import { Trans, useLingui } from "@lingui/react/macro";
import type { ModelBackupChoice, ModelCredential, ModelRole } from "@rakazo/contracts";
import {
  backupChoiceKey,
  connectedBackupOptions,
  MAX_MODEL_BACKUPS,
  moveBackupChoice,
} from "@rakazo/contracts";
import { createModelRoleSettings } from "@rakazo/core";
import { Button, Spinner } from "@rakazo/ui-web";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { providerDisplayName } from "../lib/localized-provider-hint";
import { useSpaceRpc } from "../lib/space-rpc";
import { ModelPicker } from "./model-settings/model-picker";

type Props = {
  userId: string;
  spaceId: string;
  credentials: ModelCredential[];
  modelRole?: ModelRole;
};

/** Primary selection and ordered backups share one editor for every model purpose. */
export function ModelRoleSettings({
  userId,
  spaceId,
  credentials,
  modelRole: role = "main",
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
  useEffect(() => {
    void controller.load();
  }, [controller, credentials]);
  const displayCatalog = state.catalog.map((entry) => ({
    ...entry,
    providerName: providerDisplayName(
      entry.provider,
      entry.providerName ?? entry.provider,
      credentials.find((credential) => credential.provider === entry.provider)?.authKind,
    ),
  }));
  const options = connectedBackupOptions(displayCatalog, credentials);
  const label = (choice: ModelBackupChoice) => {
    const option = displayCatalog.find(
      (entry) => entry.provider === choice.provider && entry.id === choice.modelId,
    );
    return option
      ? `${option.providerName ?? option.provider} · ${option.label}`
      : `${choice.provider} · ${choice.modelId}`;
  };
  const settings = state.settings;
  const backups = settings?.backups ?? [];
  const selected = new Set(
    [...(settings?.primary ? [settings.primary] : []), ...backups].map(backupChoiceKey),
  );
  const addable = options.filter((choice) => !selected.has(backupChoiceKey(choice)));
  const catalogOptions = (choices: typeof options) =>
    choices.map(
      (choice) =>
        displayCatalog.find(
          (entry) => entry.provider === choice.provider && entry.id === choice.modelId,
        ) ?? { provider: choice.provider, id: choice.modelId, label: choice.label, billing: "" },
    );
  if (role === "main" && !state.error && (!settings || (!backups.length && !addable.length)))
    return null;
  return (
    <section className="mt-6 border-t border-border pt-5" data-testid={`model-role-${role}`}>
      {role !== "main" ? (
        <div className="mb-4">
          <ModelPicker
            options={[
              { provider: "", id: "", label: t`Deployment default`, billing: "" },
              ...catalogOptions(options),
            ]}
            value={settings?.primary?.modelId ?? ""}
            provider={settings?.primary?.provider ?? ""}
            placeholder={settings?.primary ? label(settings.primary) : undefined}
            label={t`Approval model`}
            disabled={state.busy || !settings}
            onChange={(_id, entry) =>
              void controller.save({
                primary: entry.id ? { provider: entry.provider, modelId: entry.id } : null,
              })
            }
          />
        </div>
      ) : null}
      <h3 className="text-[13.5px] text-muted-foreground">
        <Trans>Backup models</Trans>
      </h3>
      {state.busy ? <Spinner aria-label={t`Loading model catalog…`} /> : null}
      {backups.length ? (
        <ol className="mt-3 divide-y divide-border rounded-xl border border-border">
          {backups.map((choice, index) => (
            <li
              key={backupChoiceKey(choice)}
              className="flex items-center gap-3 py-2 ps-3 pe-2"
              data-testid={`model-backup-${index + 1}`}
            >
              <span className="min-w-0 flex-1 truncate">{label(choice)}</span>
              {backups.length > 1 ? (
                <>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t`Move ${label(choice)} up`}
                    disabled={state.busy || index === 0}
                    onClick={() =>
                      void controller.save({ backups: moveBackupChoice(backups, index, -1) })
                    }
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t`Move ${label(choice)} down`}
                    disabled={state.busy || index === backups.length - 1}
                    onClick={() =>
                      void controller.save({ backups: moveBackupChoice(backups, index, 1) })
                    }
                  >
                    <ArrowDown />
                  </Button>
                </>
              ) : null}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t`Remove ${label(choice)}`}
                disabled={state.busy}
                onClick={() =>
                  void controller.save({ backups: backups.filter((_, item) => item !== index) })
                }
              >
                <X />
              </Button>
            </li>
          ))}
        </ol>
      ) : null}
      {backups.length < MAX_MODEL_BACKUPS && addable.length ? (
        <div className="mt-3">
          <ModelPicker
            options={catalogOptions(addable)}
            value=""
            label={t`Add backup model`}
            placeholder={t`Add backup model`}
            disabled={state.busy || !settings}
            onChange={(_id, entry) =>
              void controller.save({
                backups: [...backups, { provider: entry.provider, modelId: entry.id }],
              })
            }
          />
        </div>
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
