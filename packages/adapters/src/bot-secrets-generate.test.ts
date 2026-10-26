import { DEFAULT_PASSWORD_SYMBOLS, GeneratedPasswordRules } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { generateBotLogin, resolveLoginFill } from "./bot-secrets.js";
import { fakeDatabase } from "./bot-secrets.test-support.js";
import { generatePassword } from "./password-generator.js";
import { EncryptedSecretStore } from "./secrets.js";

const scope = { userId: "user-1", spaceId: "space-1", botId: "bot-1" };
const secretStore = new EncryptedSecretStore("test-only-encryption-key");
const signup = {
  name: "example_account",
  origin: "https://www.example.test/signup?ref=1",
  username: "person@example.test",
};

function generate(db: ReturnType<typeof fakeDatabase>, args: Record<string, unknown>) {
  return generateBotLogin({ prisma: db.prisma, secretStore, scope, args });
}

function escaped(characters: string) {
  return characters.replace(/[\\\]^-]/g, "\\$&");
}

describe("generatePassword", () => {
  it("defaults to 20 characters with every kind of character", () => {
    for (let run = 0; run < 50; run++) {
      const password = generatePassword(GeneratedPasswordRules.parse({}));
      expect(password).toHaveLength(20);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[0-9]/);
      expect(password).toMatch(new RegExp(`[${escaped(DEFAULT_PASSWORD_SYMBOLS)}]`));
    }
  });

  it("uses only the allowed kinds, length, and symbols", () => {
    const rules = GeneratedPasswordRules.parse({
      length: 12,
      uppercase: false,
      allowedSymbols: "!_",
    });
    for (let run = 0; run < 50; run++) {
      const password = generatePassword(rules);
      expect(password).toMatch(/^[a-z0-9!_]{12}$/);
      expect(password).toMatch(/[!_]/);
      expect(password).toMatch(/[0-9]/);
    }
    expect(
      generatePassword(
        GeneratedPasswordRules.parse({
          length: 8,
          lowercase: false,
          uppercase: false,
          symbols: false,
        }),
      ),
    ).toMatch(/^[0-9]{8}$/);
  });

  it("does not repeat", () => {
    const rules = GeneratedPasswordRules.parse({});
    const passwords = new Set(Array.from({ length: 100 }, () => generatePassword(rules)));
    expect(passwords.size).toBe(100);
  });

  it("refuses rules no site could need", () => {
    expect(GeneratedPasswordRules.safeParse({ length: 7 }).success).toBe(false);
    expect(GeneratedPasswordRules.safeParse({ length: 129 }).success).toBe(false);
    expect(GeneratedPasswordRules.safeParse({ allowedSymbols: "a!" }).success).toBe(false);
    expect(GeneratedPasswordRules.safeParse({ allowedSymbols: " " }).success).toBe(false);
    expect(
      GeneratedPasswordRules.safeParse({
        lowercase: false,
        uppercase: false,
        digits: false,
        symbols: false,
      }).success,
    ).toBe(false);
  });
});

describe("generate_login", () => {
  const savedPassword = async (db: ReturnType<typeof fakeDatabase>) => {
    const fill = await resolveLoginFill({
      prisma: db.prisma,
      secretStore,
      scope,
      name: signup.name,
      field: "password",
    });
    if ("error" in fill) throw new Error(fill.error);
    return fill;
  };

  it("saves a login for the site and returns only what hides the password", async () => {
    const db = fakeDatabase();
    const { result, redactions } = await generate(db, {
      ...signup,
      password: { length: 16, symbols: false },
    });
    expect(result).toEqual({
      saved: true,
      name: "example_account",
      origin: "https://www.example.test",
      auth: { type: "login" },
    });
    const { text: password, origin } = await savedPassword(db);
    expect(origin).toBe("https://www.example.test");
    expect(password).toMatch(/^[a-zA-Z0-9]{16}$/);
    expect(redactions).toContain(password);
    expect(db.rows()[0]!.ciphertext).not.toContain(password);
    expect(
      await resolveLoginFill({
        prisma: db.prisma,
        secretStore,
        scope,
        name: signup.name,
        field: "username",
      }),
    ).toMatchObject({ text: "person@example.test" });
  });

  it("never replaces a saved login", async () => {
    const db = fakeDatabase();
    await generate(db, signup);
    const { text: first } = await savedPassword(db);
    expect(await generate(db, signup)).toEqual({
      result: { error: expect.stringContaining("already saved for this site") },
    });
    expect(await generate(db, { ...signup, origin: "https://other.example.test" })).toEqual({
      result: { error: expect.stringContaining("already exists") },
    });
    expect((await savedPassword(db)).text).toBe(first);
  });

  it("explains invalid input", async () => {
    const db = fakeDatabase();
    expect(await generate(db, { ...signup, origin: "http://www.example.test" })).toEqual({
      result: { error: expect.stringMatching(/HTTPS origin/) },
    });
    expect(await generate(db, { ...signup, password: { length: 4 } })).toEqual({
      result: { error: expect.stringMatching(/^Invalid login — password\.length/) },
    });
    expect(await generate(db, { ...signup, username: "" })).toEqual({
      result: { error: expect.stringMatching(/username/) },
    });
    expect(db.rows()).toEqual([]);
  });
});
