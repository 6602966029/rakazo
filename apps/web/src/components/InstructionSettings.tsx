import { Trans } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { BOT_INSTRUCTIONS_MAX_LENGTH } from "@rakazo/contracts";
import { Button, Textarea } from "@rakazo/ui-web";
import { useId, useState } from "react";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

export function InstructionSettings({ bot }: { bot: Bot }) {
  const id = useId();
  const [previousBot, setPreviousBot] = useState(bot);
  const [current, setCurrent] = useState(bot);
  const [instructions, setInstructions] = useState(bot.instructions);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  if (bot !== previousBot) {
    setPreviousBot(bot);
    if (instructions === previousBot.instructions) setInstructions(bot.instructions);
    setCurrent(bot);
  }
  async function save(action: () => Promise<Bot>) {
    setPending(true);
    setError("");
    try {
      const updated = await action();
      setCurrent(updated);
      setInstructions(updated.instructions);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="mt-4 space-y-3">
      <label htmlFor={`${id}-instructions`} className="block text-sm">
        <Trans>Instructions</Trans>
        <Textarea
          id={`${id}-instructions`}
          value={instructions}
          maxLength={BOT_INSTRUCTIONS_MAX_LENGTH}
          disabled={pending}
          onChange={(event) => setInstructions(event.target.value)}
          onBlur={() => {
            if (instructions !== current.instructions)
              void save(() => rpc.bots.update({ botId: bot.id, instructions }));
          }}
        />
      </label>
      {current.instructionHistory?.length ? (
        <details>
          <summary className="cursor-pointer text-sm">
            <Trans>Instruction history</Trans>
          </summary>
          {current.instructionHistory.map((version) => (
            <div key={version.id} className="mt-2 text-sm">
              <details>
                <summary>
                  {new Date(version.createdAt).toLocaleString()} · {version.reason}
                </summary>
                <pre className="whitespace-pre-wrap">{version.instructions}</pre>
              </details>
              <Button
                variant="outline"
                disabled={pending}
                onClick={() =>
                  void save(() =>
                    rpc.bots.restoreInstructions({ botId: bot.id, versionId: version.id }),
                  )
                }
              >
                <Trans>Restore</Trans>
              </Button>
            </div>
          ))}
        </details>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
