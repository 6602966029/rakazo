import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import type { KeyProvider, KeyWrapContext, WrappedDataKey } from "@rakazo/adapter-kit";

export interface AwsKmsKeyProviderConfig {
  /** Key ARN (not an alias, which can be repointed without the stored keys noticing). */
  keyArn: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const KEY_ARN = /^arn:aws[a-z-]*:kms:([a-z0-9-]+):\d{12}:key\/([A-Za-z0-9-]+)$/;

/**
 * Credentials are required rather than taken from the SDK's default chain, so the key
 * manager never borrows credentials configured for something else.
 */
export function awsKmsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AwsKmsKeyProviderConfig {
  const keyArn = env.AWS_KMS_KEY_ARN?.trim() ?? "";
  const match = KEY_ARN.exec(keyArn);
  if (!match)
    throw new Error(
      "AWS_KMS_KEY_ARN must be a KMS key ARN (arn:aws:kms:<region>:<account>:key/<id>)",
    );
  const accessKeyId = env.AWS_KMS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.AWS_KMS_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId || !secretAccessKey)
    throw new Error(
      "AWS_KMS_ACCESS_KEY_ID and AWS_KMS_SECRET_ACCESS_KEY are required with AWS KMS",
    );
  return { keyArn, region: match[1]!, accessKeyId, secretAccessKey };
}

/**
 * Space keys wrapped by an AWS KMS key that never leaves KMS. The space and key version
 * travel as encryption context, so a wrapped key moved to another space fails to unwrap,
 * and every unwrap is recorded in CloudTrail.
 */
export class AwsKmsKeyProvider implements KeyProvider {
  private readonly client: KMSClient;
  private readonly masterKeyId: string;

  constructor(
    private readonly config: AwsKmsKeyProviderConfig,
    client?: KMSClient,
  ) {
    this.masterKeyId = `aws-kms:${KEY_ARN.exec(config.keyArn)?.[2] ?? config.keyArn}`;
    this.client =
      client ??
      new KMSClient({
        region: config.region,
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
        maxAttempts: 3,
        requestHandler: { connectionTimeout: 3_000, requestTimeout: 10_000 },
      });
  }

  describe() {
    return {
      id: "aws-kms",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { rotate: true },
    };
  }

  activeKeyId(): string {
    return this.masterKeyId;
  }

  async wrap(dataKey: Uint8Array, context: KeyWrapContext): Promise<WrappedDataKey> {
    const { CiphertextBlob } = await this.client.send(
      new EncryptCommand({
        KeyId: this.config.keyArn,
        Plaintext: dataKey,
        EncryptionContext: encryptionContext(context),
      }),
    );
    if (!CiphertextBlob) throw new Error("AWS KMS returned no ciphertext");
    return {
      masterKeyId: this.masterKeyId,
      wrappedKey: Buffer.from(CiphertextBlob).toString("base64url"),
    };
  }

  async unwrap(wrapped: WrappedDataKey, context: KeyWrapContext): Promise<Uint8Array> {
    if (wrapped.masterKeyId !== this.masterKeyId)
      throw new Error(`Master key ${wrapped.masterKeyId} is not configured`);
    let plaintext: Uint8Array | undefined;
    try {
      ({ Plaintext: plaintext } = await this.client.send(
        new DecryptCommand({
          KeyId: this.config.keyArn,
          CiphertextBlob: Buffer.from(wrapped.wrappedKey, "base64url"),
          EncryptionContext: encryptionContext(context),
        }),
      ));
    } catch (error) {
      throw new Error(`Space key could not be unwrapped with master key ${wrapped.masterKeyId}`, {
        cause: error,
      });
    }
    if (plaintext?.length !== 32) throw new Error("AWS KMS returned a malformed space key");
    return plaintext;
  }
}

function encryptionContext(context: KeyWrapContext): Record<string, string> {
  return {
    "rakazo:purpose": "space-key/v1",
    "rakazo:space": context.spaceId,
    "rakazo:version": String(context.version),
  };
}
