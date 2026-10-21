import { Host, Switch } from "@expo/ui/jetpack-compose";
import { alpha, semantics } from "@expo/ui/jetpack-compose/modifiers";
import { tokensForAppearance } from "@rakazo/ui-tokens";
import { systemGreen, useResolvedAppearance } from "../lib/native";
import type { NativeSwitchProps } from "../lib/native-controls";

/** Loaded only when the running Android binary has the Compose host and switch. */
export default function ComposeSwitch({
  value,
  onValueChange,
  disabled,
  accessibilityLabel,
  accessibilityHint,
  trackColor,
  thumbColor,
  tintColor,
}: NativeSwitchProps) {
  const scheme = useResolvedAppearance();
  const tokens = tokensForAppearance(scheme);
  const checkedTrack = trackColor?.true ?? tintColor ?? systemGreen(scheme);
  const checkedThumb = thumbColor ?? tokens.faviconPlate;
  const uncheckedTrack = trackColor?.false ?? tokens.secondary;
  const uncheckedThumb = thumbColor ?? (scheme === "dark" ? tokens.mutedForeground : tokens.muted);

  return (
    // Constrain Compose's 48dp interactive minimum to the existing row accessory footprint.
    <Host colorScheme={scheme} style={{ width: 52, height: 32, flexShrink: 0 }}>
      <Switch
        // SwitchContent reads props.value directly; SyncSwitch mutates native state first.
        value={value}
        onCheckedChange={onValueChange}
        enabled={!disabled}
        colors={{
          checkedTrackColor: checkedTrack,
          checkedThumbColor: checkedThumb,
          checkedBorderColor: "transparent",
          uncheckedTrackColor: uncheckedTrack,
          uncheckedThumbColor: uncheckedThumb,
          uncheckedBorderColor: "transparent",
          disabledCheckedTrackColor: checkedTrack,
          disabledCheckedThumbColor: checkedThumb,
          disabledCheckedBorderColor: "transparent",
          disabledUncheckedTrackColor: uncheckedTrack,
          disabledUncheckedThumbColor: uncheckedThumb,
          disabledUncheckedBorderColor: "transparent",
        }}
        modifiers={[
          // Material Switch supplies the switch role, checked state and disabled semantics.
          semantics({
            contentDescription: accessibilityHint
              ? `${accessibilityLabel}. ${accessibilityHint}`
              : accessibilityLabel,
          }),
          alpha(disabled ? 0.38 : 1),
        ]}
      />
    </Host>
  );
}
