import type { SignupSurvey as SignupSurveyAnswers } from "@rakazo/contracts";
import { signupSurveyAsksTeamSize } from "@rakazo/contracts";

import { useRef, useState } from "react";
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
import {
  SettingsGroup,
  SettingsLabel,
  SettingsRow,
  useStackedSettings,
} from "../../components/settings-group";
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
  const finished = useRef(false);
  const uses = [
    { value: "personal" as const, label: t("Personal") },
    { value: "work" as const, label: t("Work") },
    { value: "both" as const, label: t("Both") },
  ];
  const teamSizeLabel = t("How big is your team?");

  function finish() {
    if (finished.current) return;
    finished.current = true;
    // Answers are optional, so a slow or failed save never holds up the new account.
    void rpc(
      "onboarding/signupSurvey",
      signupSurveyAnswers({ reason, use, teamSize, source }),
    ).catch(() => undefined);
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
        <View style={styles.question}>
          <SettingsLabel>{t("How will you use Rakazo?")}</SettingsLabel>
          <NativeSegmentedControl
            accessibilityLabel={t("How will you use Rakazo?")}
            onChange={setUse}
            options={uses}
            value={use ?? ("" as Use)}
          />
        </View>
        {signupSurveyAsksTeamSize(use) ? (
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
            maxLength={500}
            onChangeText={setSource}
            style={styles.input}
            value={source}
          />
        </SettingsGroup>
        <SettingsGroup label={t("What do you most want Rakazo to help with?")}>
          <TextInput
            accessibilityLabel={t("What do you most want Rakazo to help with?")}
            maxLength={2000}
            multiline
            onChangeText={setReason}
            placeholder={t("Optional")}
            placeholderTextColor={native.tertiaryLabel}
            style={[styles.input, styles.multiline]}
            textAlignVertical="top"
            value={reason}
          />
        </SettingsGroup>
        <NativeActionButton label={t("Continue")} onPress={finish} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32, gap: 28 },
    compactContent: { paddingHorizontal: 8 },
    question: { gap: 7 },
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
