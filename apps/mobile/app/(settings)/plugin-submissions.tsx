import type { PluginSubmission, PluginSubmissionStatus } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ConnectorIcon } from "../../components/connector-icon";
import { LoadFailure } from "../../components/load-failure";
import { TextFieldDialog } from "../../components/name-dialog";
import { NativeActionButton } from "../../components/native-action-button";
import { NativeSegmentedControl } from "../../components/native-segmented-control";
import { SettingsGroup, SettingsLabel, SettingsRow } from "../../components/settings-group";
import { useI18n } from "../../lib/i18n";
import { native, useThemedStyles } from "../../lib/native";
import {
  pluginSubmissionsQuery,
  rejectionReason,
  reviewPluginSubmission,
} from "../../lib/plugin-submissions";
import { queryClient } from "../../lib/query";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

/** Admin review of plugins submitted from the website. Approved ones join the marketplace. */
export default function PluginSubmissions() {
  const { t } = useI18n();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const [status, setStatus] = useState<PluginSubmissionStatus>("pending");
  const submissions = useQuery(pluginSubmissionsQuery(status), queryClient);
  const [openId, setOpenId] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  // Android has no system text prompt, so the reason is asked in a dialog.
  const [rejecting, setRejecting] = useState<PluginSubmission | null>(null);
  const [reason, setReason] = useState("");

  async function review(submission: PluginSubmission, reason?: string) {
    setPending(submission.id);
    try {
      await reviewPluginSubmission(
        reason
          ? { id: submission.id, decision: "reject", reason }
          : { id: submission.id, decision: "approve" },
      );
      setRejecting(null);
    } catch (err) {
      Alert.alert(errorText(err));
    } finally {
      setPending(null);
    }
  }

  function reject(submission: PluginSubmission) {
    if (Platform.OS !== "ios") {
      setReason("");
      setRejecting(submission);
      return;
    }
    Alert.prompt(
      t("Why reject {name}?", { name: submission.name }),
      undefined,
      [
        { text: t("Cancel"), style: "cancel" },
        {
          text: t("Reject"),
          style: "destructive",
          onPress: (value?: string) => {
            const answer = rejectionReason(value);
            if (answer) void review(submission, answer);
            else reject(submission);
          },
        },
      ],
      "plain-text",
    );
  }

  function link(url: string) {
    return (
      <Text
        accessibilityRole="link"
        numberOfLines={1}
        onPress={() => void Linking.openURL(url)}
        style={styles.link}
      >
        {url.replace(/^https:\/\//, "")}
      </Text>
    );
  }

  function renderSubmission(submission: PluginSubmission) {
    const open = openId === submission.id;
    const busy = pending === submission.id;
    return (
      <View key={submission.id}>
        <SettingsRow
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          chevron={open ? "down" : "right"}
          detail={submission.email}
          dimmed={busy}
          leading={<ConnectorIcon logo={submission.logo} name={submission.name} size={32} />}
          onPress={() => setOpenId(open ? null : submission.id)}
          title={submission.name}
        />
        {open ? (
          <View style={styles.detail}>
            {link(submission.source)}
            {submission.website ? link(submission.website) : null}
            <Text selectable style={styles.body}>
              {submission.description}
            </Text>
            <SettingsLabel>{t("Testing")}</SettingsLabel>
            <Text selectable style={styles.body}>
              {submission.testing}
            </Text>
            {submission.reason ? (
              <>
                <SettingsLabel>{t("Reason")}</SettingsLabel>
                <Text selectable style={styles.body}>
                  {submission.reason}
                </Text>
              </>
            ) : null}
            {submission.status === "pending" ? (
              <View style={styles.actions}>
                <NativeActionButton
                  busy={busy}
                  disabled={pending !== null}
                  fill={false}
                  label={t("Approve")}
                  onPress={() => void review(submission)}
                />
                <NativeActionButton
                  disabled={pending !== null}
                  fill={false}
                  label={t("Reject")}
                  onPress={() => reject(submission)}
                  prominence="secondary"
                />
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        <NativeSegmentedControl
          accessibilityLabel={t("Status")}
          onChange={(value) => {
            setStatus(value);
            setOpenId(null);
          }}
          options={[
            { value: "pending", label: t("Pending") },
            { value: "approved", label: t("Approved") },
            { value: "rejected", label: t("Rejected") },
          ]}
          value={status}
        />
        {submissions.error && !submissions.data ? (
          <LoadFailure
            message={errorText(submissions.error)}
            onRetry={() => void submissions.refetch()}
          />
        ) : !submissions.data ? (
          <ActivityIndicator color={native.secondaryLabel} accessibilityLabel={t("Loading…")} />
        ) : submissions.data.length ? (
          <SettingsGroup>{submissions.data.map(renderSubmission)}</SettingsGroup>
        ) : (
          <Text style={styles.empty}>{t("No results")}</Text>
        )}
      </ScrollView>
      {rejecting ? (
        <TextFieldDialog
          title={t("Why reject {name}?", { name: rejecting.name })}
          label={t("Reason")}
          submitLabel={t("Reject")}
          value={reason}
          error={null}
          saving={pending !== null}
          input={{ multiline: true, maxLength: 1000 }}
          onChange={setReason}
          onSubmit={(value) => {
            const answer = rejectionReason(value);
            if (answer) void review(rejecting, answer);
          }}
          onClose={() => setRejecting(null)}
        />
      ) : null}
    </SafeAreaView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { width: "100%", padding: 20, gap: 24, paddingBottom: 40 },
    detail: { paddingHorizontal: 16, paddingBottom: 16, gap: 8 },
    body: { color: native.label, fontSize: 15, lineHeight: 21 },
    link: { color: native.label, fontSize: 15, textDecorationLine: "underline" },
    actions: { flexDirection: "row", gap: 8, marginTop: 8 },
    empty: { color: native.secondaryLabel, fontSize: 15, textAlign: "center" },
  });
}
