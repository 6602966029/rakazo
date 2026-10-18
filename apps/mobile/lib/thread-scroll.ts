import type { ThreadScrollState } from "@rakazo/core";

export type { ThreadScrollState } from "@rakazo/core";

export type ThreadScrollAction = "jump" | "smooth" | null;

export class ThreadScrollBehavior {
  private threadKey: string | null = null;
  private laidOut = false;
  private contentReady = false;
  private viewportHeight: number | null = null;
  private contentHeight: number | null = null;
  private distanceFromEnd = 0;
  private latestMessageId: string | null = null;
  private currentState: ThreadScrollState = { detached: false, unread: false };

  openThread(threadKey: string): void {
    if (this.threadKey === threadKey) return;
    this.threadKey = threadKey;
    this.laidOut = false;
    this.contentReady = false;
    this.latestMessageId = null;
    this.viewportHeight = null;
    this.contentHeight = null;
    this.distanceFromEnd = 0;
    this.currentState = { detached: false, unread: false };
  }

  onLayout(viewportHeight?: number): ThreadScrollAction {
    this.laidOut = true;
    if (viewportHeight !== undefined) {
      this.viewportHeight = viewportHeight;
      this.onUserScroll(this.distanceFromEnd);
    }
    return this.contentReady && !this.currentState.detached ? "jump" : null;
  }

  onContentChanged(blocked: boolean, latestMessageId: string | null): ThreadScrollAction {
    if (blocked) return null;
    this.contentReady = true;
    if (latestMessageId === null || latestMessageId === this.latestMessageId) return null;
    const initial = this.latestMessageId === null;
    this.latestMessageId = latestMessageId;
    if (initial) return this.laidOut ? "jump" : null;
    if (this.currentState.detached) {
      this.currentState = { detached: true, unread: true };
      return null;
    }
    return "smooth";
  }

  onContentSizeChanged(height: number): ThreadScrollState {
    this.contentHeight = height;
    return this.onUserScroll(this.distanceFromEnd);
  }

  onUserScroll(distanceFromEnd: number): ThreadScrollState {
    const scrollable =
      this.contentHeight === null ||
      this.viewportHeight === null ||
      this.contentHeight > this.viewportHeight;
    this.distanceFromEnd = scrollable ? Math.max(0, distanceFromEnd) : 0;
    const detached = this.distanceFromEnd > 80;
    this.currentState = {
      detached,
      unread: detached ? this.currentState.unread : false,
    };
    return this.state();
  }

  jumpToLatest(): ThreadScrollAction {
    this.distanceFromEnd = 0;
    this.currentState = { detached: false, unread: false };
    return "smooth";
  }

  state(): ThreadScrollState {
    return { ...this.currentState };
  }
}
