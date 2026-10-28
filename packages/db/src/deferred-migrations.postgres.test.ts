import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFERRED_MIGRATION_MARKER, heldBackMigrations } from "./deferred-migrations.js";

const databaseUrl = process.env.DATABASE_URL;
const dbTests = process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

dbTests("deferred migrations", () => {
  const stamp = `${process.pid}_${Date.now()}`;
  const dir = mkdtempSync(path.join(tmpdir(), "deferred-migrations-"));
  const deferred = `29990101000000_deferred_${stamp}`;
  const freshSchema = `deferred_fresh_${stamp}`;
  let client: Client;

  function migration(name: string, sql: string) {
    mkdirSync(path.join(dir, name));
    writeFileSync(path.join(dir, name, "migration.sql"), sql);
  }

  beforeAll(async () => {
    migration("29990101000000_plain", "SELECT 1;\n");
    migration(deferred, `${DEFERRED_MIGRATION_MARKER}\nSELECT 1;\n`);
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`CREATE SCHEMA "${freshSchema}"`);
  });

  afterAll(async () => {
    await client.query('DELETE FROM "_deferred_migrations" WHERE name = $1', [deferred]);
    await client.query(`DROP SCHEMA "${freshSchema}"`);
    await client.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it("holds nothing back on a database with no migrations applied", async () => {
    const fresh = new URL(databaseUrl!);
    fresh.searchParams.set("options", `-c search_path=${freshSchema}`);
    await expect(heldBackMigrations(fresh.toString(), dir)).resolves.toEqual([]);
  });

  it("holds a new deferred migration back once, then lets it run", async () => {
    await expect(heldBackMigrations(databaseUrl!, dir)).resolves.toEqual([deferred]);
    await expect(heldBackMigrations(databaseUrl!, dir)).resolves.toEqual([]);
  });
});
