import type { MemoryDocument, ScratchpadItem } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { errorText } from "../lib/user-error";
import { NativeActionButton } from "./native-action-button";
import { NativeSwitch } from "./native-switch";

export function BotContextCards({ botId }: { botId: string }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [work, setWork] = useState<ScratchpadItem[]>([]);
  const [docs, setDocs] = useState<MemoryDocument[]>([]);
  const [allWork, setAllWork] = useState(false);
  const [allDocs, setAllDocs] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void Promise.all([
      rpc<ScratchpadItem[]>("scratchpad/list", { botId }),
      rpc<MemoryDocument[]>("memory/list", { botId, scope: "bot" }),
    ])
      .then(([items, documents]) => {
        if (current) {
          setWork(items);
          setDocs(documents);
        }
      })
      .catch((err) => {
        if (current) setError(errorText(err));
      });
    return () => {
      current = false;
    };
  }, [botId]);
  const heading = { color: tokens.mutedForeground, fontSize: 12, marginBottom: 8 };
  const card = { backgroundColor: native.fill, borderRadius: 12, padding: 16, gap: 12 };
  return (
    <>
      {work.length ? (
        <View style={{ marginTop: 24 }}>
          <Text accessibilityRole="header" style={heading}>
            {t("Open work")}
          </Text>
          <View style={card}>
            {(allWork ? work : work.slice(0, 5)).map((item) => (
              <View key={item.id} style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: tokens.foreground, fontSize: 14 }}>{item.title}</Text>
                  {item.notes ? (
                    <Text style={{ color: tokens.mutedForeground, fontSize: 12, marginTop: 4 }}>
                      {item.notes}
                    </Text>
                  ) : null}
                </View>
                <NativeSwitch
                  accessibilityLabel={`${t("Complete")} ${item.title}`}
                  value={false}
                  disabled={busy}
                  onValueChange={() => {
                    setBusy(true);
                    void rpc("scratchpad/update", { itemId: item.id, status: "done" })
                      .then(() => setWork((items) => items.filter((entry) => entry.id !== item.id)))
                      .catch((err) => setError(errorText(err)))
                      .finally(() => setBusy(false));
                  }}
                />
              </View>
            ))}
            {!allWork && work.length > 5 ? (
              <NativeActionButton
                label={t("Show more")}
                prominence="plain"
                onPress={() => setAllWork(true)}
              />
            ) : null}
          </View>
        </View>
      ) : null}
      {docs.length ? (
        <View style={{ marginTop: 24 }}>
          <Text accessibilityRole="header" style={heading}>
            {t("Memory")}
          </Text>
          <View style={card}>
            {(allDocs ? docs : docs.slice(0, 5)).map((doc) => (
              <Pressable
                key={doc.id}
                accessibilityRole="button"
                accessibilityLabel={doc.path}
                onPress={() => Alert.alert(doc.path, doc.content)}
                style={{ minHeight: 44, justifyContent: "center" }}
              >
                <Text style={{ color: tokens.foreground, fontSize: 14 }}>{doc.path}</Text>
              </Pressable>
            ))}
            {!allDocs && docs.length > 5 ? (
              <NativeActionButton
                label={t("Show more")}
                prominence="plain"
                onPress={() => setAllDocs(true)}
              />
            ) : null}
          </View>
        </View>
      ) : null}
      {error ? <Text style={{ color: tokens.destructive, marginTop: 16 }}>{error}</Text> : null}
    </>
  );
}
