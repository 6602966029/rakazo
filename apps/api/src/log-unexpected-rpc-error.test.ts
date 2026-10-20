import { ORPCError } from "@orpc/server";
import { SandboxRateLimitError } from "@rakazo/adapter-kit";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it } from "vitest";
import { handleRpcError, logUnexpectedRpcError } from "./app.js";

describe("logUnexpectedRpcError", () => {
  afterEach(() => {
    installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] }));
  });

  it("stays quiet for an error the router chose to return", () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));

    logUnexpectedRpcError(new ORPCError("BAD_REQUEST", { message: "file is too large" }), [
      "computer",
      "readFile",
    ]);

    expect(sink.events).toEqual([]);
  });

  it("names the procedure and every cause behind an opaque failure", () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const error = new Error("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:7091"), {
        code: "ECONNREFUSED",
      }),
    });

    logUnexpectedRpcError(error, ["computer", "screenUrl"]);

    expect(sink.events[0]).toMatchObject({
      message: "rpc computer/screenUrl failed",
      error: {
        message: "fetch failed",
        cause: { message: "connect ECONNREFUSED 127.0.0.1:7091" },
      },
    });
  });

  it("returns a provider rate limit as too many requests and still logs the cause", () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const error = new SandboxRateLimitError({ cause: new Error("HTTP 429, rate_limited") });

    let thrown: unknown;
    try {
      handleRpcError(error, ["computer", "boot"]);
    } catch (failure) {
      thrown = failure;
    }

    expect(thrown).toBeInstanceOf(ORPCError);
    expect(thrown).toMatchObject({ code: "TOO_MANY_REQUESTS", message: error.message });
    expect(sink.events[0]).toMatchObject({
      message: "rpc computer/boot failed",
      error: { cause: { message: "HTTP 429, rate_limited" } },
    });
  });
});
