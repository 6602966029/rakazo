import { MenuView } from "@expo/ui/community/menu";
import type { ModelCredential, ModelRole, ModelRoleSettings as Settings } from "@rakazo/contracts";
import {
  backupChoiceKey,
  connectedBackupOptions,
  MAX_MODEL_BACKUPS,
  moveBackupChoice,
} from "@rakazo/contracts";
import { createModelRoleSettings } from "@rakazo/core";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { AccessibilityInfo, Text } from "react-native";
import { captureApiRequestContext, currentApiBase, rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import type { ModelPickerRequest } from "../lib/model-picker-selection";
import { SettingsGroup, SettingsRow } from "./settings-group";

/** Native menus and pickers over the same role settings and lifecycle as web. */
export function ModelRoleSettings({
  userId,
  spaceId,
  modelRole: role,
  credentials,
  openPicker,
}: {
  userId: string;
  spaceId: string;
  modelRole: ModelRole;
  credentials: ModelCredential[];
  openPicker: (request: ModelPickerRequest) => void;
}) {
  const { t } = useI18n();
  const apiBase = currentApiBase();
  const controller = useMemo(() => {
    const requestContext = captureApiRequestContext().then((context) => ({
      ...context,
      headers: { ...context.headers, "x-rakazo-space-id": spaceId },
    }));
    const call = async <T,>(proc: string, patch = {}) =>
      rpc<T>(
        proc,
        { role, expectedUserId: userId, ...patch },
        { requestContext: await requestContext },
      );
    return createModelRoleSettings(
      {
        load: () => call<Settings>("models/role"),
        catalog: () => call("models/forRole"),
        save: (patch) => call<Settings>("models/setRole", patch),
      },
      JSON.stringify([apiBase, userId, spaceId, role]),
    );
  }, [apiBase, userId, spaceId, role]);
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  useEffect(() => {
    void controller.load();
  }, [controller, credentials]);
  useEffect(() => {
    if (state.error) AccessibilityInfo.announceForAccessibility(state.error);
  }, [state.error]);
  const choices = connectedBackupOptions(state.catalog, credentials);
  const settings = state.settings;
  const backups = settings?.backups ?? [];
  const label = (choice: { provider: string; modelId: string }) => {
    const model = state.catalog.find(
      (entry) => entry.provider === choice.provider && entry.id === choice.modelId,
    );
    return model
      ? `${model.providerName ?? model.provider} · ${model.label}`
      : `${choice.provider} · ${choice.modelId}`;
  };
  const selected = new Set(
    [...(settings?.primary ? [settings.primary] : []), ...backups].map(backupChoiceKey),
  );
  function pick(primary: boolean) {
    if (state.busy || !settings) return;
    openPicker({
      title: primary ? t("Approval model") : t("Add backup model"),
      selectedKey: primary && settings.primary ? backupChoiceKey(settings.primary) : "",
      choices: [
        ...(primary
          ? [
              {
                key: "default",
                label: t("Deployment default"),
                modelLabel: t("Deployment default"),
                providerLabel: "",
              },
            ]
          : []),
        ...choices
          .filter((choice) => primary || !selected.has(backupChoiceKey(choice)))
          .map((choice) => ({
            ...choice,
            key: backupChoiceKey(choice),
            label: label(choice),
            modelLabel: choice.label,
            providerLabel: choice.providerName,
          })),
      ],
      onSelect: (choice) => {
        const model =
          choice.provider && choice.modelId
            ? { provider: choice.provider, modelId: choice.modelId }
            : null;
        void controller.save(
          primary ? { primary: model } : { backups: model ? [...backups, model] : backups },
        );
      },
    });
  }
  if (role === "main" && !state.error && (!settings || (!backups.length && !choices.length)))
    return null;
  const groupLabel = role === "main" ? t("Backup models") : t("Approval model");
  return (
    <SettingsGroup accessibilityLabel={groupLabel} label={groupLabel}>
      {role !== "main" ? (
        <SettingsRow
          title={settings?.primary ? label(settings.primary) : t("Deployment default")}
          disabled={state.busy}
          onPress={() => pick(true)}
        />
      ) : null}
      {backups.map((choice, index) => {
        const option = choices.find((entry) => backupChoiceKey(entry) === backupChoiceKey(choice));
        const name =
          option?.label ??
          state.catalog.find(
            (entry) => entry.provider === choice.provider && entry.id === choice.modelId,
          )?.label ??
          choice.modelId;
        const actions = [
          ...(index > 0 ? [{ id: "moveUp", title: t("Move up") }] : []),
          ...(index < backups.length - 1 ? [{ id: "moveDown", title: t("Move down") }] : []),
          { id: "remove", title: t("Remove"), attributes: { destructive: true } },
        ];
        const action = (id: string) => {
          if (state.busy) return;
          void controller.save({
            backups:
              id === "remove"
                ? backups.filter((_, i) => i !== index)
                : moveBackupChoice(backups, index, id === "moveUp" ? -1 : 1),
          });
        };
        return (
          <MenuView
            key={backupChoiceKey(choice)}
            title={name}
            actions={actions}
            onPressAction={({ nativeEvent }) => action(nativeEvent.event)}
          >
            <SettingsRow
              accessible
              accessibilityRole="button"
              title={name}
              detail={option?.providerName ?? t("Not connected")}
              disabled={state.busy}
              accessibilityActions={actions.map((entry) => ({
                name: entry.id,
                label: entry.title,
              }))}
              onAccessibilityAction={({ nativeEvent }) => action(nativeEvent.actionName)}
            />
          </MenuView>
        );
      })}
      {backups.length < MAX_MODEL_BACKUPS &&
      choices.some((choice) => !selected.has(backupChoiceKey(choice))) ? (
        <SettingsRow
          title={t("Add backup model")}
          disabled={state.busy}
          onPress={() => pick(false)}
        />
      ) : null}
      {state.error ? (
        <>
          <Text accessibilityRole="alert">{state.error}</Text>
          <SettingsRow
            title={t("Retry")}
            disabled={state.busy}
            onPress={() => void controller.load()}
          />
        </>
      ) : null}
    </SettingsGroup>
  );
}
