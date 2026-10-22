/**
 * Distance from the top of the screen to the chat's keyboard avoiding view.
 *
 * Android measures it in the window. On iOS 26 and later the header floats over the chat,
 * so the chat starts at the top of the screen. Earlier iOS versions draw an opaque header
 * and the chat starts below it.
 */
export function threadKeyboardOffset({
  os,
  floatingHeader,
  nativeHeaderHeight,
  measuredOffset,
}: {
  os: string;
  floatingHeader: boolean;
  nativeHeaderHeight: number;
  measuredOffset: number;
}) {
  if (os === "android") return measuredOffset;
  if (os === "ios" && !floatingHeader) return nativeHeaderHeight;
  return 0;
}
