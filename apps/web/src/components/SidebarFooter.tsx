import { Trans, useLingui } from "@lingui/react/macro";
import { Button, buttonVariants, Popover, PopoverContent, PopoverTrigger } from "@rakazo/ui-web";
import {
  BookOpen,
  Download,
  FolderOpen,
  Gauge,
  LogOut,
  Settings,
  Smartphone,
  SquareKanban,
  UserRound,
} from "lucide-react";
import { useState } from "react";
import { useSidebarUpdate } from "./DesktopUpdates";

type Props = {
  name: string;
  initials: string;
  image?: string | null;
  logos?: Array<{ name: string; logo?: string | null }>;
  email?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIntegrations: () => void;
  onBoard?: () => void;
  onArtifacts: () => void;
  onSettings: () => void;
  onUsage: () => void;
  onLogOut: () => void;
  signingOut: boolean;
  logOutError: string | null;
};

export function SidebarFooter({
  name,
  initials,
  image,
  logos = [],
  email,
  open,
  onOpenChange,
  onIntegrations,
  onBoard,
  onArtifacts,
  onSettings,
  onUsage,
  onLogOut,
  signingOut,
  logOutError,
}: Props) {
  const { t } = useLingui();
  const update = useSidebarUpdate();
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const [failedLogos, setFailedLogos] = useState<string[]>([]);
  return (
    <div
      data-testid="sidebar-footer"
      className="@container flex shrink-0 items-center gap-2 px-2.5 py-3"
    >
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger
          data-testid="user-menu-trigger"
          aria-label={t`Account menu for ${name}`}
          className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-full border border-border bg-sidebar-accent text-sm font-medium text-foreground outline-none hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring"
        >
          {image && failedImage !== image ? (
            <img
              src={image}
              alt=""
              className="size-full object-cover"
              onError={() => setFailedImage(image)}
            />
          ) : initials ? (
            initials
          ) : (
            <UserRound size={18} aria-hidden="true" />
          )}
        </PopoverTrigger>
        {open ? (
          <PopoverContent
            side="top"
            sideOffset={8}
            align="start"
            className="w-[295px] max-w-[calc(100vw-69px)] gap-0 p-1 data-closed:animate-none"
          >
            {update.available ? (
              <div className="flex items-center justify-between gap-2 border-b border-border px-2.5 py-2">
                <span className="text-sm">
                  <Trans>New update available</Trans>
                </span>
                <Button size="lg" disabled={update.busy} onClick={update.install}>
                  <Trans>Install</Trans>
                </Button>
              </div>
            ) : null}
            <div
              data-testid="account-menu-header"
              className="mb-1 min-w-0 border-b border-border px-2.5 py-2.5"
            >
              <p className="truncate text-sm font-medium">{name}</p>
              {email && email !== name ? (
                <p className="truncate text-xs text-muted-foreground">{email}</p>
              ) : null}
            </div>
            <Button
              variant="ghost"
              className="h-9 w-full justify-start gap-2.5 font-normal"
              onClick={onUsage}
            >
              <Gauge className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Usage</Trans>
            </Button>
            <a
              className={`${buttonVariants({ variant: "ghost" })} h-9 w-full justify-start gap-2.5 font-normal`}
              href={
                /Android/i.test(navigator.userAgent)
                  ? "https://github.com/elie222/rakazo/releases/download/android/rakazo.apk"
                  : "https://apps.apple.com/app/rakazo/id6801531099"
              }
              target="_blank"
              rel="noreferrer"
            >
              <Smartphone className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Get the mobile app</Trans>
            </a>
            <a
              className={`${buttonVariants({ variant: "ghost" })} h-9 w-full justify-start gap-2.5 font-normal`}
              href="https://github.com/elie222/rakazo/blob/main/docs/self-host.md"
              target="_blank"
              rel="noreferrer"
            >
              <BookOpen className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Docs</Trans>
            </a>
            {onBoard ? (
              <Button
                variant="ghost"
                className="h-9 w-full justify-start gap-2.5 font-normal"
                onClick={onBoard}
              >
                <SquareKanban className="text-muted-foreground" strokeWidth={1.75} />
                <Trans>Board</Trans>
              </Button>
            ) : null}
            <Button
              variant="ghost"
              className="h-9 w-full justify-start gap-2.5 font-normal"
              onClick={onArtifacts}
            >
              <FolderOpen className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Artifacts</Trans>
            </Button>
            <Button
              variant="ghost"
              className="h-9 w-full justify-start gap-2.5 font-normal"
              aria-label={t`Settings`}
              onClick={onSettings}
            >
              <Settings className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Settings</Trans>
            </Button>
            <div className="my-1 border-t border-border" />
            <Button
              variant="ghost"
              className="h-9 w-full justify-start gap-2.5 font-normal"
              disabled={signingOut}
              onClick={onLogOut}
            >
              <LogOut className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Log out</Trans>
            </Button>
            {logOutError ? (
              <p role="alert" className="px-2.5 pt-1 pb-2 text-[13px] text-destructive">
                {logOutError}
              </p>
            ) : null}
          </PopoverContent>
        ) : null}
      </Popover>
      <Button
        variant="outline"
        onClick={onIntegrations}
        className="h-9 min-w-0 flex-1 justify-between rounded-full bg-sidebar-accent hover:border-foreground/30 hover:bg-sidebar-accent"
      >
        <span className="truncate">
          <Trans>Connect apps</Trans>
        </span>
        <span aria-hidden="true" className="flex shrink-0 items-center -space-x-1.5">
          {logos.slice(0, 3).map((app, index) => (
            <span
              key={app.name}
              className={`size-6 shrink-0 place-items-center overflow-hidden rounded-full border border-border bg-muted text-xs font-medium text-foreground ring-2 ring-sidebar-accent ${index === 2 ? "hidden @min-[280px]:grid" : "grid"}`}
            >
              {app.logo && !failedLogos.includes(app.logo) ? (
                <img
                  src={app.logo}
                  alt=""
                  className="size-full object-contain"
                  onError={() => setFailedLogos((failed) => [...failed, app.logo!])}
                />
              ) : (
                app.name[0]
              )}
            </span>
          ))}
        </span>
      </Button>
      {update.available ? (
        <Button
          size="icon-lg"
          className="rounded-full"
          aria-label={t`Install update`}
          disabled={update.busy}
          onClick={update.install}
        >
          <Download aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}
