/** Apply edits immediately, saving one at a time and retaining only the latest edit. */
export function createQueuedSave<T>(
  initial: T,
  {
    save,
    onChange,
    onError,
    onSaved,
    onSavingChange,
    equals = Object.is,
  }: {
    save: (value: T) => Promise<void>;
    onChange: (value: T) => void;
    onError: (error: unknown) => void;
    onSaved?: (value: T) => Promise<void>;
    onSavingChange?: (saving: boolean) => void;
    equals?: (a: T, b: T) => boolean;
  },
) {
  let confirmed = initial;
  let latest = initial;
  let saving = false;

  async function drain() {
    saving = true;
    onSavingChange?.(true);
    try {
      while (!equals(latest, confirmed)) {
        const next = latest;
        try {
          await save(next);
        } catch (error) {
          latest = confirmed;
          onChange(confirmed);
          onError(error);
          break;
        }
        confirmed = next;
        try {
          await onSaved?.(next);
        } catch (error) {
          onError(error);
        }
      }
    } finally {
      saving = false;
      onSavingChange?.(false);
    }
  }

  return {
    // A fresh read can replace the baseline when it did not overlap a save.
    reset(value: T) {
      if (!saving) confirmed = latest = value;
    },
    update(value: T) {
      latest = value;
      onChange(value);
      if (!saving) void drain();
    },
  };
}
