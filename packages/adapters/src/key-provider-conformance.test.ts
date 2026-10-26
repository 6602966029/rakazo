import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { KMSClient } from "@aws-sdk/client-kms";
import type { KeyProvider } from "@rakazo/adapter-kit";
import { LocalKeyProvider, withLocalMasterKeys } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AwsKmsKeyProvider, awsKmsConfigFromEnv } from "./aws-kms-key-provider.js";
import { contentKeyProviderFromEnv } from "./key-provider-factory.js";

const KEY_ARN = "arn:aws:kms:eu-central-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab";
const config = {
  keyArn: KEY_ARN,
  region: "eu-central-1",
  accessKeyId: "fake-access-key",
  secretAccessKey: "fake-secret-key",
};

/**
 * Just enough of the KMS JSON protocol to exercise the adapter offline: Encrypt and
 * Decrypt under one key, with the encryption context authenticated like KMS does.
 * Signatures are not checked.
 */
function fakeKms() {
  const master = randomBytes(32);
  const state = { down: false, contexts: [] as Record<string, string>[] };
  const aad = (context: Record<string, string> = {}) =>
    Buffer.from(JSON.stringify(Object.entries(context).sort(([a], [b]) => a.localeCompare(b))));
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const send = (status: number, body: object) => {
      res.writeHead(status, { "content-type": "application/x-amz-json-1.1" });
      res.end(JSON.stringify(body));
    };
    const fail = (type: string) => send(400, { __type: type, message: type });
    if (state.down) return send(500, { __type: "KMSInternalException", message: "down" });
    if (input.KeyId !== KEY_ARN) return fail("NotFoundException");
    state.contexts.push(input.EncryptionContext);
    const action = req.headers["x-amz-target"];
    if (action === "TrentService.Encrypt") {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", master, iv);
      cipher.setAAD(aad(input.EncryptionContext));
      const body = Buffer.concat([
        cipher.update(Buffer.from(input.Plaintext, "base64")),
        cipher.final(),
      ]);
      const blob = Buffer.concat([iv, body, cipher.getAuthTag()]);
      return send(200, { CiphertextBlob: blob.toString("base64"), KeyId: KEY_ARN });
    }
    if (action === "TrentService.Decrypt") {
      const blob = Buffer.from(input.CiphertextBlob, "base64");
      try {
        const decipher = createDecipheriv("aes-256-gcm", master, blob.subarray(0, 12));
        decipher.setAAD(aad(input.EncryptionContext));
        decipher.setAuthTag(blob.subarray(blob.length - 16));
        const plain = Buffer.concat([
          decipher.update(blob.subarray(12, blob.length - 16)),
          decipher.final(),
        ]);
        return send(200, { Plaintext: plain.toString("base64"), KeyId: KEY_ARN });
      } catch {
        return fail("InvalidCiphertextException");
      }
    }
    return fail("UnknownOperationException");
  });
  return { server, state };
}

const kms = fakeKms();
let client: KMSClient;
beforeAll(async () => {
  await new Promise<void>((resolve) => kms.server.listen(0, "127.0.0.1", resolve));
  client = new KMSClient({
    region: config.region,
    endpoint: `http://127.0.0.1:${(kms.server.address() as AddressInfo).port}`,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    maxAttempts: 1,
  });
});
afterAll(async () => {
  client.destroy();
  await new Promise((resolve) => kms.server.close(resolve));
});

const local = () => new LocalKeyProvider([{ id: "k1", key: randomBytes(32) }]);
const aws = () => new AwsKmsKeyProvider(config, client);

function conformance(name: string, create: () => KeyProvider) {
  describe(`${name} KeyProvider conformance`, () => {
    const context = { spaceId: "space-a", version: 1 };

    it("unwraps what it wraps, under the active key, without revealing the data key", async () => {
      const provider = create();
      const dataKey = randomBytes(32);
      const wrapped = await provider.wrap(dataKey, context);
      expect(wrapped.masterKeyId).toBe(provider.activeKeyId());
      expect(wrapped.wrappedKey).not.toContain(dataKey.toString("base64url"));
      expect(Buffer.from(await provider.unwrap(wrapped, context))).toEqual(dataKey);
      expect((await provider.wrap(dataKey, context)).wrappedKey).not.toBe(wrapped.wrappedKey);
    });

    it("binds the wrap to its space and version", async () => {
      const provider = create();
      const wrapped = await provider.wrap(randomBytes(32), context);
      await expect(provider.unwrap(wrapped, { ...context, spaceId: "space-b" })).rejects.toThrow();
      await expect(provider.unwrap(wrapped, { ...context, version: 2 })).rejects.toThrow();
    });

    it("rejects tampered wraps and unknown master keys", async () => {
      const provider = create();
      const wrapped = await provider.wrap(randomBytes(32), context);
      const bytes = Buffer.from(wrapped.wrappedKey, "base64url");
      bytes[bytes.length - 1]! ^= 1;
      await expect(
        provider.unwrap({ ...wrapped, wrappedKey: bytes.toString("base64url") }, context),
      ).rejects.toThrow();
      await expect(
        provider.unwrap({ ...wrapped, masterKeyId: "missing" }, context),
      ).rejects.toThrow();
    });
  });
}

conformance("local", local);
conformance("AWS KMS", aws);
conformance("AWS KMS with local master keys", () => withLocalMasterKeys(aws(), local()));

describe("AWS KMS key provider", () => {
  it("sends the space and version as encryption context", async () => {
    kms.state.contexts.length = 0;
    await aws().wrap(randomBytes(32), { spaceId: "space-a", version: 3 });
    expect(kms.state.contexts).toEqual([
      { "rakazo:purpose": "space-key/v1", "rakazo:space": "space-a", "rakazo:version": "3" },
    ]);
  });

  it("names the master key and keeps the cause when KMS is unavailable", async () => {
    const provider = aws();
    const wrapped = await provider.wrap(randomBytes(32), { spaceId: "s", version: 1 });
    kms.state.down = true;
    try {
      const error = await provider.unwrap(wrapped, { spaceId: "s", version: 1 }).catch((e) => e);
      expect(error.message).toBe(
        "Space key could not be unwrapped with master key aws-kms:1234abcd-12ab-34cd-56ef-1234567890ab",
      );
      expect(error.cause).toBeDefined();
    } finally {
      kms.state.down = false;
    }
  });

  it("reads its configuration from the environment", () => {
    const env = {
      AWS_KMS_KEY_ARN: KEY_ARN,
      AWS_KMS_ACCESS_KEY_ID: "fake-access-key",
      AWS_KMS_SECRET_ACCESS_KEY: "fake-secret-key",
    };
    expect(awsKmsConfigFromEnv(env)).toEqual(config);
    expect(() =>
      awsKmsConfigFromEnv({
        ...env,
        AWS_KMS_KEY_ARN: "arn:aws:kms:eu-central-1:111122223333:alias/rakazo",
      }),
    ).toThrow("AWS_KMS_KEY_ARN");
    expect(() => awsKmsConfigFromEnv({ ...env, AWS_KMS_SECRET_ACCESS_KEY: "" })).toThrow(
      "AWS_KMS_SECRET_ACCESS_KEY",
    );
  });
});

describe("moving space keys to a key manager", () => {
  it("wraps new keys with KMS while locally wrapped keys still unwrap", async () => {
    const env = local();
    const context = { spaceId: "space-a", version: 1 };
    const dataKey = randomBytes(32);
    const old = await env.wrap(dataKey, context);
    const provider = withLocalMasterKeys(aws(), env);
    expect(Buffer.from(await provider.unwrap(old, context))).toEqual(dataKey);
    // What `content-encryption rotate` does with each stored key.
    const moved = await provider.wrap(await provider.unwrap(old, context), context);
    expect(moved.masterKeyId).toBe("aws-kms:1234abcd-12ab-34cd-56ef-1234567890ab");
    expect(Buffer.from(await provider.unwrap(moved, context))).toEqual(dataKey);
  });

  it("is selected by MASTER_KEY_PROVIDER, failing at startup on bad configuration", () => {
    expect(contentKeyProviderFromEnv({})).toBeUndefined();
    expect(contentKeyProviderFromEnv({ MASTER_KEY_PROVIDER: "local" })).toBeUndefined();
    expect(() => contentKeyProviderFromEnv({ MASTER_KEY_PROVIDER: "vault" })).toThrow(
      "Unsupported MASTER_KEY_PROVIDER",
    );
    expect(() => contentKeyProviderFromEnv({ MASTER_KEY_PROVIDER: "aws-kms" })).toThrow(
      "AWS_KMS_KEY_ARN",
    );
    const provider = contentKeyProviderFromEnv({
      MASTER_KEY_PROVIDER: "aws-kms",
      AWS_KMS_KEY_ARN: KEY_ARN,
      AWS_KMS_ACCESS_KEY_ID: "fake-access-key",
      AWS_KMS_SECRET_ACCESS_KEY: "fake-secret-key",
      ENCRYPTION_KEY: "fake-encryption-key-for-tests-0000000000000000000000000000",
    });
    expect(provider?.activeKeyId()).toBe("aws-kms:1234abcd-12ab-34cd-56ef-1234567890ab");
  });
});
