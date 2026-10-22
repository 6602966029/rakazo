import type { SignupSurvey as SignupSurveyAnswers } from "@rakazo/contracts";

import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { MenuPickerMenu } from "../../components/menu-picker";
import { NativeActionButton } from "../../components/native-action-button";
import { NativeSegmentedControl } from "../../components/native-segmented-control";
import { NativeSymbol } from "../../components/native-symbol";
import { SettingsGroup, SettingsRow, useStackedSettings } from "../../components/settings-group";
import { rpc } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { native, useThemedStyles } from "../../lib/native";
import { closeSettingsSheet } from "../../lib/settings-sheet";
import type { SignupSurveyTeamSize } from "../../lib/signup-survey";
import { SIGNUP_SURVEY_TEAM_SIZE_CHOICES, signupSurveyAnswers } from "../../lib/signup-survey";

type Use = NonNullable<SignupSurveyAnswers["use"]>;

/** Optional questions shown once after a hosted sign-up. */
export default function SignupSurvey() {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const stacked = useStackedSettings();
  const [reason, setReason] = useState("");
  const [use, setUse] = useState<Use>();
  const [teamSize, setTeamSize] = useState<SignupSurveyTeamSize>();
  const [source, setSource] = useState("");
  const [pending, setPending] = useState(false);
  const uses = [
    { value: "personal" as const, label: t("Personal") },
    { value: "work" as const, label: t("Work") },
  ];
  const teamSizeLabel = t("How big is your team?");

  async function finish() {
    if (pending) return;
    setPending(true);
    // Answers are a courtesy: a failed save never holds up the new account.
    await rpc("onboarding/signupSurvey", signupSurveyAnswers({ reason, use, teamSize, source }))
      .catch(() => undefined)
      .finally(() => setPending(false));
    closeSettingsSheet();
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.screen}
    >
      <ScrollView
        contentContainerStyle={[styles.content, stacked && styles.compactContent]}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        <SettingsGroup label={t("What are you hoping to use Rakazo for?")}>
          <TextInput
            accessibilityLabel={t("What are you hoping to use Rakazo for?")}
            editable={!pending}
            maxLength={2000}
            multiline
            onChangeText={setReason}
            style={[styles.input, styles.multiline]}
            textAlignVertical="top"
            value={reason}
          />
        </SettingsGroup>
        <NativeSegmentedControl
          accessibilityLabel={uses.map((option) => option.label).join(" / ")}
          disabled={pending}
          onChange={setUse}
          options={uses}
          value={use ?? ("" as Use)}
        />
        {use === "work" ? (
          <SettingsGroup>
            <MenuPickerMenu
              choices={SIGNUP_SURVEY_TEAM_SIZE_CHOICES}
              label={teamSizeLabel}
              onChange={(key) =>
                setTeamSize(
                  SIGNUP_SURVEY_TEAM_SIZE_CHOICES.find((choice) => choice.key === key)?.key,
                )
              }
              value={teamSize ?? ""}
            >
              <View>
                <SettingsRow
                  accessibilityLabel={teamSizeLabel}
                  accessibilityRole="button"
                  accessible
                  title={teamSizeLabel}
                  trailing={
                    <NativeSymbol
                      android="chevron-expand"
                      color={native.tertiaryLabel}
                      ios="chevron.up.chevron.down"
                      size={13}
                    />
                  }
                  value={
                    SIGNUP_SURVEY_TEAM_SIZE_CHOICES.find((choice) => choice.key === teamSize)?.label
                  }
                />
              </View>
            </MenuPickerMenu>
          </SettingsGroup>
        ) : null}
        <SettingsGroup label={t("How did you hear about us?")}>
          <TextInput
            accessibilityLabel={t("How did you hear about us?")}
            editable={!pending}
            maxLength={500}
            onChangeText={setSource}
            onSubmitEditing={() => void finish()}
            returnKeyType="done"
            style={styles.input}
            value={source}
          />
        </SettingsGroup>
        <NativeActionButton busy={pending} label={t("Continue")} onPress={() => void finish()} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32, gap: 28 },
    compactContent: { paddingHorizontal: 8 },
    input: {
      minHeight: 48,
      paddingHorizontal: 16,
      paddingVertical: 12,
      color: native.label,
      fontSize: 16,
    },
    multiline: { minHeight: 96 },
  });
}
