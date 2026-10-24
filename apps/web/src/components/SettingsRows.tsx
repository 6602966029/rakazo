import type { ReactNode } from "react";

/** A titled list of settings rows sharing one bordered surface. */
export function SettingsGroup({
  title,
  children,
  "data-testid": testId,
}: {
  title?: ReactNode;
  children: ReactNode;
  "data-testid"?: string;
}) {
  return (
    <section data-testid={testId}>
      {title ? (
        <h3 className="mb-2 px-1 text-[14px] font-medium text-foreground">{title}</h3>
      ) : null}
      <div className="divide-y divide-border rounded-xl border border-border">{children}</div>
    </section>
  );
}

/** One setting: its label on the left, its control on the right, optional detail below. */
export function SettingsRow({
  label,
  control,
  children,
}: {
  label: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="px-4 py-3">
      <div className="flex min-h-9 items-center justify-between gap-4">
        <div className="min-w-0 text-[14px] text-foreground">{label}</div>
        {control ? <div className="flex shrink-0 items-center gap-2">{control}</div> : null}
      </div>
      {children}
    </div>
  );
}
