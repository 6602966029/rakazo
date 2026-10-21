import type { IpcMainInvokeEvent, WebContents } from "electron";

export function createBadgeHandler(
  getTarget: () => { webContents: WebContents; url: string } | null,
  setBadgeCount: (count: number) => boolean,
) {
  return (event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">, count: unknown): boolean => {
    try {
      const target = getTarget();
      if (
        !target ||
        target.webContents.isDestroyed() ||
        event.sender !== target.webContents ||
        event.senderFrame !== event.sender.mainFrame ||
        !event.senderFrame
      )
        return false;
      const origin = new URL(target.url).origin;
      if (origin === "null" || new URL(event.senderFrame.url).origin !== origin) return false;
      const valid = typeof count === "number" && Number.isInteger(count) && count >= 0;
      return setBadgeCount(valid ? Math.min(count, 9999) : 0);
    } catch {
      return false;
    }
  };
}
