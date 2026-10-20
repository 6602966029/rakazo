import type { IntegrationSetupState } from "@rakazo/contracts";
import { credentialIssue } from "@rakazo/core";
import { Redirect, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  AccessibilityInfo,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeActionButton } from "../components/native-action-button";
import type { PasswordResetCapabilities } from "../lib/api";
import {
  currentApiBase,
  displayApiHost,
  loadSessionToken,
  passwordResetCapabilities,
  requestPasswordReset,
  rpc,
  sendSignInCode,
  signIn,
  signInWithCode,
  signUp,
  usesCustomApiBase,
} from "../lib/api";
import type { AuthMode } from "../lib/auth-routing";
import { initialAuthMode } from "../lib/auth-routing";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { continueWithSso } from "../lib/sso";
import { credentialIssueText, errorText } from "../lib/user-error";

export default function SignIn() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const router = useRouter();
  const { mode: requestedMode } = useLocalSearchParams<{ mode?: string | string[] }>();
  const [mode, setMode] = useState<AuthMode>(() => initialAuthMode(requestedMode));
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [ready, setReady] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [apiBase, setApiBase] = useState(() => currentApiBase());
  const [reset, setReset] = useState<PasswordResetCapabilities | null>(null);
  const [capabilityError, setCapabilityError] = useState(false);
  const [capabilityAttempt, setCapabilityAttempt] = useState(0);
  const [resetSent, setResetSent] = useState(false);
  const [usePassword, setUsePassword] = useState(false);
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);

  useFocusEffect(
    useCallback(() => {
      setApiBase(currentApiBase());
    }, []),
  );

  useEffect(() => {
    void loadSessionToken().then((token) => {
      setHasSession(Boolean(token));
      setReady(true);
    });
  }, []);

  useEffect(() => {
    let active = true;
    setReset(null);
    setCapabilityError(false);
    void passwordResetCapabilities()
      .then((capabilities) => {
        if (active) setReset(capabilities);
      })
      .catch(() => {
        if (active) setCapabilityError(true);
      });
    return () => {
      active = false;
    };
  }, [apiBase, capabilityAttempt]);

  useEffect(() => {
    if (resetSent || codeSent) AccessibilityInfo.announceForAccessibility(t("Check your email"));
  }, [resetSent, codeSent, t]);

  if (!ready) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: tokens.background,
          justifyContent: "center",
          padding: 24,
        }}
      >
        <Text style={{ color: tokens.mutedForeground, textAlign: "center" }}>{t("Loading…")}</Text>
      </View>
    );
  }
  if (hasSession) return <Redirect href="/" />;

  const codeFlow = Boolean(reset?.passwordAuth && reset.emailCode && mode !== "forgot");
  const usingCode = codeFlow && !usePassword;
  const codeStep = usingCode && codeSent;

  async function submit(enteredCode = code) {
    if (pending || !reset?.passwordAuth) return;
    const issue = credentialIssue({
      email,
      password: mode === "forgot" || usingCode ? undefined : password,
    });
    if (issue) {
      setError(credentialIssueText(issue));
      return;
    }
    setPending(true);
    setError(null);
    try {
      if (mode === "forgot") {
        if (!reset?.passwordReset || !reset.resetUrl) {
          throw new Error(t("Password recovery is not configured for this server"));
        }
        await requestPasswordReset(email.trim(), reset.resetUrl);
        setResetSent(true);
        return;
      }
      if (usingCode && !codeSent) {
        await sendSignInCode(email.trim());
        setCode("");
        setCodeSent(true);
        return;
      }
      if (usingCode) {
        await signInWithCode(
          email.trim(),
          enteredCode,
          mode === "up" ? name.trim() || undefined : undefined,
        );
      } else if (mode === "up") {
        const trimmedEmail = email.trim();
        const result = await signUp(
          trimmedEmail,
          password,
          name.trim() || trimmedEmail.split("@")[0] || "User",
        );
        if (result.verificationRequired) {
          setResetSent(true);
          return;
        }
      } else {
        await signIn(email.trim(), password);
      }
      const setup =
        mode === "up"
          ? await rpc<IntegrationSetupState>("integrationSetup/get").catch(() => null)
          : null;
      router.replace(setup?.needsSetup ? "/integration-setup" : "/");
    } catch (err) {
      setError(errorText(err, t("Could not continue")));
    } finally {
      setPending(false);
    }
  }

  async function sso() {
    setPending(true);
    setError(null);
    try {
      if (await continueWithSso()) router.replace("/");
    } catch (err) {
      setError(errorText(err, t("Could not continue")));
    } finally {
      setPending(false);
    }
  }

  const custom = usesCustomApiBase(apiBase);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
          <View style={{ flex: 1 }}>
            <ScrollView
              contentContainerStyle={{
                flexGrow: 1,
                justifyContent: "center",
                paddingHorizontal: 24,
                paddingVertical: 24,
              }}
              keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
              keyboardShouldPersistTaps="handled"
            >
              <Text
                accessibilityRole="header"
                style={{
                  color: tokens.foreground,
                  fontSize: 32,
                  fontWeight: "500",
                  textAlign: "center",
                }}
              >
                {resetSent || codeStep
                  ? t("Check your email")
                  : mode === "in"
                    ? t("Sign in to Rakazo")
                    : mode === "up"
                      ? t("Sign up for Rakazo")
                      : t("Reset your password")}
              </Text>
              {resetSent ? (
                <View style={{ alignItems: "center", marginTop: 28 }}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      setMode("in");
                      setResetSent(false);
                      setCodeSent(false);
                    }}
                  >
                    <Text style={{ color: tokens.foreground, fontSize: 15, fontWeight: "600" }}>
                      {t("Back to sign in")}
                    </Text>
                  </Pressable>
                </View>
              ) : (
                <>
                  {capabilityError ? (
                    <View accessibilityRole="alert">
                      <Text style={{ color: tokens.destructive }}>
                        {t("Could not load sign-in options")}
                      </Text>
                      <NativeActionButton
                        label={t("Retry")}
                        onPress={() => setCapabilityAttempt((value) => value + 1)}
                      />
                    </View>
                  ) : !reset ? (
                    <Text
                      style={{ color: tokens.mutedForeground, textAlign: "center", marginTop: 16 }}
                    >
                      {t("Loading…")}
                    </Text>
                  ) : null}
                  {reset?.sso && !reset.passwordAuth && mode !== "forgot" ? (
                    <NativeActionButton
                      label={t("Continue with {name}", { name: reset.sso.name })}
                      disabled={pending}
                      onPress={() => void sso()}
                      style={{ marginTop: 16 }}
                    />
                  ) : null}
                  {error && !reset?.passwordAuth ? (
                    <Text
                      accessibilityRole="alert"
                      style={{ color: tokens.destructive, marginTop: 12 }}
                    >
                      {error}
                    </Text>
                  ) : null}
                  {reset?.passwordAuth && codeStep ? (
                    <>
                      <TextInput
                        accessibilityLabel={t("Code")}
                        autoComplete="one-time-code"
                        autoFocus
                        keyboardType="number-pad"
                        maxLength={6}
                        placeholder={t("Code")}
                        placeholderTextColor={tokens.mutedForeground}
                        textContentType="oneTimeCode"
                        value={code}
                        onChangeText={(value) => {
                          const digits = value.replace(/\D/g, "").slice(0, 6);
                          setCode(digits);
                          // iOS offers the code from Mail; a complete code signs in at once.
                          if (digits.length === 6) void submit(digits);
                        }}
                        onSubmitEditing={() => void submit()}
                        style={{
                          marginTop: 28,
                          backgroundColor: tokens.muted,
                          borderRadius: 13,
                          padding: 16,
                          color: tokens.foreground,
                        }}
                      />
                      {error ? (
                        <Text style={{ color: tokens.destructive, marginTop: 12 }}>{error}</Text>
                      ) : null}
                      <NativeActionButton
                        disabled={pending}
                        label={pending ? t("Working…") : t("Continue")}
                        onPress={() => void submit()}
                        style={{ marginTop: 16 }}
                      />
                      <NativeActionButton
                        label={t("Back")}
                        prominence="quiet"
                        disabled={pending}
                        onPress={() => {
                          setCodeSent(false);
                          setCode("");
                          setError(null);
                        }}
                        style={{ alignSelf: "center", marginTop: 16 }}
                      />
                    </>
                  ) : reset?.passwordAuth ? (
                    <>
                      {mode === "up" ? (
                        <TextInput
                          autoComplete="name"
                          placeholder={t("Name")}
                          placeholderTextColor={tokens.mutedForeground}
                          value={name}
                          onChangeText={setName}
                          style={{
                            marginTop: 28,
                            backgroundColor: tokens.muted,
                            borderRadius: 13,
                            padding: 16,
                            color: tokens.foreground,
                          }}
                        />
                      ) : null}
                      <TextInput
                        autoCapitalize="none"
                        autoComplete="email"
                        keyboardType="email-address"
                        placeholder={t("Email")}
                        placeholderTextColor={tokens.mutedForeground}
                        value={email}
                        onChangeText={setEmail}
                        style={{
                          marginTop: mode === "up" ? 12 : 28,
                          backgroundColor: tokens.muted,
                          borderRadius: 13,
                          padding: 16,
                          color: tokens.foreground,
                        }}
                      />
                      {mode !== "forgot" && !usingCode ? (
                        <TextInput
                          autoComplete={mode === "in" ? "current-password" : "new-password"}
                          placeholder={t("Password")}
                          placeholderTextColor={tokens.mutedForeground}
                          returnKeyType="go"
                          secureTextEntry
                          value={password}
                          onChangeText={setPassword}
                          onSubmitEditing={() => void submit()}
                          style={{
                            marginTop: 12,
                            backgroundColor: tokens.muted,
                            borderRadius: 13,
                            padding: 16,
                            color: tokens.foreground,
                          }}
                        />
                      ) : null}
                      {error ? (
                        <Text style={{ color: tokens.destructive, marginTop: 12 }}>{error}</Text>
                      ) : null}
                      <NativeActionButton
                        disabled={pending}
                        label={
                          pending
                            ? t("Working…")
                            : usingCode
                              ? t("Continue")
                              : mode === "in"
                                ? t("Sign in")
                                : mode === "up"
                                  ? t("Sign up")
                                  : t("Send reset link")
                        }
                        onPress={() => void submit()}
                        style={{ marginTop: 16 }}
                      />
                      {codeFlow ? (
                        <NativeActionButton
                          label={usingCode ? t("Use password") : t("Use email code")}
                          prominence="quiet"
                          disabled={pending}
                          onPress={() => {
                            setUsePassword(usingCode);
                            setError(null);
                          }}
                          style={{ alignSelf: "center", marginTop: 16 }}
                        />
                      ) : null}
                      {reset.sso && mode !== "forgot" ? (
                        <NativeActionButton
                          label={t("Continue with {name}", { name: reset.sso.name })}
                          prominence="quiet"
                          disabled={pending}
                          onPress={() => void sso()}
                          style={{ alignSelf: "center", marginTop: 16 }}
                        />
                      ) : null}
                      {mode === "in" && !usingCode && reset?.passwordReset && reset.resetUrl ? (
                        <Pressable
                          accessibilityRole="button"
                          hitSlop={8}
                          onPress={() => {
                            setMode("forgot");
                            setError(null);
                          }}
                          style={{ alignSelf: "center", marginTop: 16 }}
                        >
                          <Text
                            style={{ color: tokens.foreground, fontSize: 14, fontWeight: "600" }}
                          >
                            {t("Forgot password?")}
                          </Text>
                        </Pressable>
                      ) : null}
                      <View
                        style={{
                          flexDirection: "row",
                          justifyContent: "center",
                          alignItems: "center",
                          marginTop: 24,
                        }}
                      >
                        <Text style={{ color: tokens.mutedForeground, fontSize: 15 }}>
                          {mode === "in"
                            ? t("Don’t have an account?")
                            : mode === "up"
                              ? t("Already have an account?")
                              : ""}
                        </Text>
                        <Pressable
                          accessibilityRole="button"
                          hitSlop={8}
                          onPress={() => {
                            setMode((current) => (current === "in" ? "up" : "in"));
                            setError(null);
                          }}
                          style={{ marginLeft: 5 }}
                        >
                          <Text
                            style={{ color: tokens.foreground, fontSize: 15, fontWeight: "600" }}
                          >
                            {mode === "in"
                              ? t("Sign up")
                              : mode === "up"
                                ? t("Sign in")
                                : t("Back to sign in")}
                          </Text>
                        </Pressable>
                      </View>
                    </>
                  ) : null}
                </>
              )}
            </ScrollView>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                custom
                  ? t("Custom server {host}", { host: displayApiHost(apiBase) })
                  : t("Use a custom server")
              }
              hitSlop={12}
              onPress={() => router.push("/server")}
              style={{
                alignItems: "center",
                paddingHorizontal: 24,
                paddingBottom: 12,
                paddingTop: 8,
              }}
            >
              {custom ? (
                <>
                  <Text style={{ color: tokens.mutedForeground, fontSize: 12 }}>
                    {t("Custom server")}
                  </Text>
                  <Text style={{ color: tokens.mutedForeground, fontSize: 13, marginTop: 2 }}>
                    {displayApiHost(apiBase)}
                  </Text>
                </>
              ) : (
                <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>
                  {t("Use a custom server")}
                </Text>
              )}
            </Pressable>
          </View>
        </TouchableWithoutFeedback>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
