import type { RunErrorTranslator } from "@rakazo/core";

export function runErrorExplanation(t: RunErrorTranslator, connection: boolean, model: boolean) {
  return connection
    ? t("Add your own key or pick another model.")
    : model
      ? t("Choose another model to keep chatting.")
      : null;
}

/** Only human-readable fields leave this boundary. Copy retains the original diagnostic. */
export function parseRunDiagnostic(raw: string, locale: string) {
  const prefix = /^\s*(\d{3})\s*:\s*/.exec(raw);
  const body = raw.slice(prefix?.[0].length ?? 0);
  let record: Record<string, unknown> = {};
  try {
    record = asRecord(JSON.parse(body));
  } catch {
    // Malformed provider envelopes are still readable without JSON punctuation.
  }
  const nested = asRecord(record.error);
  const payload = Object.keys(nested).length ? nested : record;
  const metadata = asRecord(payload.metadata ?? record.metadata);
  const message = readable(typeof payload.message === "string" ? payload.message : body);
  const status = Number(prefix?.[1] ?? record.status ?? record.code ?? payload.code);
  const limit = /\b(daily|weekly|monthly)\b/i
    .exec(String(payload.limit ?? metadata.limit ?? message))?.[1]
    ?.toLowerCase();
  const reset =
    payload.reset_at ??
    payload.reset ??
    metadata.reset_at ??
    metadata.reset ??
    message.match(/\bresets?\s+(\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?)/i)?.[1];
  let resets: string | undefined;
  if (typeof reset === "string" && /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?$/.test(reset)) {
    const date = new Date(reset);
    if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === reset.slice(0, 10)) {
      resets = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
        date,
      );
    }
  }
  return {
    status: Number.isInteger(status) && status >= 100 && status <= 599 ? String(status) : undefined,
    message,
    limit,
    resets,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function readable(value: string) {
  return value.replace(/[{}[\]"“”]/g, "").trim();
}
