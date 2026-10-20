import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { mountAppAssociation } from "./app-association.js";
import { loadEnv } from "./env.js";

const fingerprint = Array.from({ length: 32 }, () => "AB").join(":");

function association(env: Record<string, string>) {
  const app = new Hono();
  mountAppAssociation(
    app,
    loadEnv({
      DATABASE_URL: "postgres://rakazo:rakazo@127.0.0.1:5433/rakazo",
      NODE_ENV: "test",
      ...env,
    }),
  );
  return app;
}

describe("native app association", () => {
  it("serves only the files a deployment configures", async () => {
    const app = association({});
    expect((await app.request("/.well-known/apple-app-site-association")).status).toBe(404);
    expect((await app.request("/.well-known/assetlinks.json")).status).toBe(404);
  });

  it("lists the configured apps for passkeys", async () => {
    const app = association({
      PASSKEY_APPLE_APP_IDS: "TEAMID0000.com.example.app",
      PASSKEY_ANDROID_CERT_SHA256: ` ${fingerprint} `,
    });
    const apple = await app.request("/.well-known/apple-app-site-association");
    expect(apple.headers.get("content-type")).toContain("application/json");
    expect(await apple.json()).toEqual({
      webcredentials: { apps: ["TEAMID0000.com.example.app"] },
    });
    expect(await (await app.request("/.well-known/assetlinks.json")).json()).toEqual([
      {
        relation: ["delegate_permission/common.get_login_creds"],
        target: {
          namespace: "android_app",
          package_name: "com.rakazo.app",
          sha256_cert_fingerprints: [fingerprint],
        },
      },
    ]);
  });
});
