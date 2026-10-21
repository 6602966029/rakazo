import { iosAtLeast } from "./native-controls";

export function threadHeaderOptions(backgroundColor: string) {
  // On iOS 27 devices, the transparent native header can obscure the entire inverted list.
  // Use a solid header there; keep the iOS 26 layout and its hidden scroll edge effects.
  const headerTransparent = iosAtLeast(26) && !iosAtLeast(27);
  return {
    headerTransparent,
    headerStyle: { backgroundColor: headerTransparent ? "transparent" : backgroundColor },
  };
}
