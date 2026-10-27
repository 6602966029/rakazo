import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import * as Logging from "@rakazo/logging";
import { describe, expect, it, vi } from "vitest";
import type { CardFillStep } from "./browser-tools.js";
import {
  browserActFromTool,
  browserNavigateFromTool,
  browserSnapshotFromTool,
  parseBrowserActions,
} from "./browser-tools.js";
import { FakeBrowserProvider } from "./fake-browser.js";
import { PageBrowserSession } from "./page-browser-session.js";

const merchant = "https://shop.example.test";
const card = { number: "4242424242424242", cvc: "123" };
const checkout = `<!doctype html><html><head><title>Checkout</title></head><body>
  <input aria-label="Card number" inputmode="numeric" />
  <input aria-label="Phone" type="tel" />
  <input aria-label="Security code" type="password" />
  <input aria-label="Email" type="email" />
  <input aria-label="Search" type="search" />
  <textarea aria-label="Notes"></textarea>
  <select aria-label="Country"><option>US</option></select>
  <div aria-label="Editor" contenteditable="true"></div>
</body></html>`;

function checkoutSession(url = `${merchant}/pay`) {
  const session = new PageBrowserSession(url, checkout);
  // Every snapshot hands out new refs, so a batch uses the refs of one.
  const refs = () => {
    const { elements } = session.snapshot();
    return (name: string) => elements.find((el) => el.name === name)!.ref;
  };
  return { session, ref: refs() };
}

const cardFill = (ref: string, text: string, origin = merchant) => ({
  kind: "fill" as const,
  ref,
  text,
  origin,
  field: "card" as const,
});

describe("in-process page browser card fill", () => {
  it("types card details on the merchant's HTTPS origin and keeps them out of snapshots", () => {
    const { session, ref } = checkoutSession();
    const result = session.act([
      cardFill(ref("Card number"), card.number),
      cardFill(ref("Phone"), card.number),
      cardFill(ref("Security code"), card.cvc),
    ]);
    expect(result).toMatchObject({ ok: true, completed: 3 });
    expect(JSON.stringify(result)).not.toContain(card.number);
    expect(JSON.stringify(session.snapshot())).not.toContain(card.number);
    expect(JSON.stringify(session.snapshot())).not.toContain(card.cvc);
  });

  it("refuses another site, plain HTTP, and fills without the merchant's origin", () => {
    for (const [url, origin, error] of [
      ["https://evil.example.test/pay", merchant, /not on the merchant's site/],
      ["https://shop.example.test.evil.test/pay", merchant, /not on the merchant's site/],
      ["http://shop.example.test/pay", "http://shop.example.test", /only be filled on HTTPS/],
      [`${merchant}/pay`, "", /only be filled on HTTPS/],
    ] as const) {
      const { session, ref } = checkoutSession(url);
      const result = session.act([
        { ...cardFill(ref("Card number"), card.number), origin: origin || undefined },
      ]);
      expect(result, url).toMatchObject({ ok: false, completed: 0, uncertain: false });
      expect(result, url).not.toHaveProperty("fallback");
      expect(result.error, url).toMatch(error);
      expect(result.error, url).not.toMatch(/login/);
      expect(JSON.stringify(result), url).not.toContain(card.number);
    }
  });

  it("types a card only into a text, telephone, or password input", () => {
    for (const name of ["Email", "Search", "Notes", "Country", "Editor"]) {
      const { session, ref } = checkoutSession();
      const result = session.act([cardFill(ref(name), card.number)]);
      expect(result, name).toMatchObject({
        ok: false,
        completed: 0,
        uncertain: false,
        error: "A card can only be typed into a card field.",
      });
      expect(JSON.stringify(result), name).not.toContain(card.number);
    }
  });

  it("forgets a field's card once the bot types over it", () => {
    const { session, ref } = checkoutSession();
    const filled = session.act([cardFill(ref("Card number"), card.number)]);
    const field = filled.elements!.find((el) => el.name === "Card number")!.ref;
    session.act([{ kind: "fill", ref: field, text: "visible" }]);
    expect(JSON.stringify(session.snapshot())).toContain("visible");
  });
});

describe("browser_act fill_card", () => {
  const context: AdapterContext = {
    operationId: "1",
    traceId: "1",
    spaceId: "w",
    userId: "u",
    signal: new AbortController().signal,
  };
  const computer: ComputerRef = { id: "c1", botId: "b1", kind: "fake", providerRef: "c1" };
  const url = `${merchant}/pay`;

  async function checkoutBrowser() {
    const browser = new FakeBrowserProvider({ pages: { [url]: { html: checkout } } });
    await browserNavigateFromTool(browser, computer, context, { url });
    const snap = (await browserSnapshotFromTool(browser, computer, context, {})) as {
      elements: Array<{ ref: string; name: string }>;
    };
    const ref = (name: string) => snap.elements.find((el) => el.name === name)!.ref;
    return { browser, ref };
  }
  const resolveCardFill = async (step: CardFillStep) => ({
    text: card[step.field],
    origin: merchant,
  });

  it("parses fill_card without a value", () => {
    expect(
      parseBrowserActions([{ kind: "fill_card", ref: "e1", purchase: "p1", field: "cvc" }]),
    ).toEqual([{ kind: "fill_card", ref: "e1", purchase: "p1", field: "cvc" }]);
  });

  it.each([
    [
      "a fill_card without its purchase",
      { kind: "fill_card", ref: "e1", field: "number" },
      "browser_act fill_card needs purchase: the id of an approved purchase",
    ],
    [
      "a fill_card without its field",
      { kind: "fill_card", ref: "e1", purchase: "p1" },
      'browser_act fill_card needs field: "number" or "cvc"',
    ],
    [
      "a fill_card for another card detail",
      { kind: "fill_card", ref: "e1", purchase: "p1", field: "expiry" },
      'browser_act fill_card needs field: "number" or "cvc"',
    ],
  ])("settles %s before anything runs", async (_, action, error) => {
    const browser = new FakeBrowserProvider();
    const act = vi.spyOn(browser, "act");
    const resolve = vi.fn();
    const result = await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "click", ref: "e0" }, action] },
      { resolveCardFill: resolve },
    );
    expect(result).toEqual({ ok: false, completed: 0, uncertain: false, error });
    expect(act).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("types the card and never shows its number to the model", async () => {
    const { browser, ref } = await checkoutBrowser();
    const act = vi.spyOn(browser, "act");
    const result = await browserActFromTool(
      browser,
      computer,
      context,
      {
        actions: [
          { kind: "fill_card", ref: ref("Card number"), purchase: "p1", field: "number" },
          { kind: "fill_card", ref: ref("Security code"), purchase: "p1", field: "cvc" },
        ],
      },
      // Only the number is long enough to redact; the CVC is kept out by the fill itself.
      { resolveCardFill, redactions: () => [card.number] },
    );
    expect(result).toMatchObject({ ok: true, completed: 2 });
    expect(act.mock.calls[0]?.[1].actions).toEqual([
      cardFill(ref("Card number"), card.number),
      cardFill(ref("Security code"), card.cvc),
    ]);
    expect(JSON.stringify(result)).not.toContain(card.number);
    expect(JSON.stringify(result)).not.toContain(card.cvc);
  });

  it("refuses the whole batch when a purchase cannot be filled, before anything runs", async () => {
    const { browser, ref } = await checkoutBrowser();
    const act = vi.spyOn(browser, "act");
    const result = await browserActFromTool(
      browser,
      computer,
      context,
      {
        actions: [
          { kind: "fill", ref: ref("Phone"), text: "555" },
          { kind: "fill_card", ref: ref("Card number"), purchase: "p1", field: "number" },
        ],
      },
      { resolveCardFill: async () => ({ error: "This purchase is not approved." }) },
    );
    expect(result).toEqual({
      ok: false,
      completed: 0,
      uncertain: false,
      error: "This purchase is not approved.",
    });
    expect(act).not.toHaveBeenCalled();
  });

  it("says card fills are unavailable where no resolver is wired", async () => {
    const result = await browserActFromTool(new FakeBrowserProvider(), computer, context, {
      actions: [{ kind: "fill_card", ref: "e1", purchase: "p1", field: "number" }],
    });
    expect(result).toMatchObject({ ok: false, error: "Card fills are unavailable here." });
  });

  it("says only that a card failed to load, never what the error quoted", async () => {
    const warn = vi.fn();
    const logger = vi.spyOn(Logging, "getLogger").mockReturnValue({ warn } as never);
    try {
      const result = await browserActFromTool(
        new FakeBrowserProvider(),
        computer,
        context,
        { actions: [{ kind: "fill_card", ref: "e1", purchase: "p1", field: "number" }] },
        { resolveCardFill: async () => JSON.parse(`card ${card.number}`) },
      );
      expect(result).toEqual({
        ok: false,
        completed: 0,
        uncertain: false,
        error: "This card could not be loaded.",
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(card.number);
      expect(warn).toHaveBeenCalledWith(expect.any(String), { errorName: "SyntaxError" });
    } finally {
      logger.mockRestore();
    }
  });
});
