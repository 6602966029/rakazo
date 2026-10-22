import { Platform } from "react-native";

// Inversion can spread a side edge's tint across the entire message list.
export const threadScrollEdgeEffects = {
  top: "hidden",
  bottom: "hidden",
  left: "hidden",
  right: "hidden",
} as const;

export const THREAD_HEADER_FADE_SOLID = 16;
export const THREAD_HEADER_FADE_GRADIENT = 32;

export function threadHeaderClearance(headerHeight: number) {
  const fadeHeight = headerHeight > 0 ? THREAD_HEADER_FADE_SOLID + THREAD_HEADER_FADE_GRADIENT : 0;
  return {
    opaqueHeight: headerHeight > 0 ? headerHeight + THREAD_HEADER_FADE_SOLID : 0,
    padding: headerHeight + fadeHeight + 8,
    anchor: headerHeight + fadeHeight + 24,
    minHeight: headerHeight > 0 ? headerHeight + fadeHeight + 8 : 0,
  };
}

export function threadHeaderFloats() {
  return Platform.OS === "ios";
}

export function threadEdgeOptions() {
  const floatingHeader = threadHeaderFloats();
  return {
    headerTransparent: floatingHeader,
    ...(floatingHeader
      ? { headerStyle: { backgroundColor: "transparent" }, headerShadowVisible: false }
      : {}),
    scrollEdgeEffects: threadScrollEdgeEffects,
  };
}
