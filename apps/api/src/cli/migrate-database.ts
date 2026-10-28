// `pnpm db:migrate`: schema migrations, the job queue schema, then the runtime
// login. Everything here runs as the migration (owner) role; the API and worker
// then connect with DATABASE_URL and only get the runtime grants.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrateJobQueue } from "@rakazo/adapters";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import {
  databaseUrls,
  heldBackMigrations,
  provisionRuntimeRole,
  RUNTIME_ROLE,
  SINGLE_DATABASE_URL_WARNING,
} from "@rakazo/db";

loadRootEnv();
const urls = databaseUrls(process.env);
const dbPackage = execFileSync("pnpm", ["--filter", "@rakazo/db", "exec", "pwd"], {
  encoding: "utf8",
}).trim();
const migrationsDir = path.join(dbPackage, "prisma/migrations");
const held = await heldBackMigrations(urls.migrationUrl, migrationsDir);
let migrationsPath = migrationsDir;
if (held.length) {
  migrationsPath = mkdtempSync(path.join(tmpdir(), "rakazo-migrations-"));
  cpSync(migrationsDir, migrationsPath, {
    recursive: true,
    filter: (source) => !held.includes(path.relative(migrationsDir, source).split(path.sep)[0]!),
  });
  process.stdout.write(`Holding back until the next migration run: ${held.join(", ")}\n`);
}
try {
  execFileSync("pnpm", ["--filter", "@rakazo/db", "exec", "prisma", "migrate", "deploy"], {
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_MIGRATION_URL: urls.migrationUrl,
      RAKAZO_MIGRATIONS_PATH: migrationsPath,
    },
  });
} finally {
  if (migrationsPath !== migrationsDir) rmSync(migrationsPath, { recursive: true, force: true });
}
await migrateJobQueue(urls.migrationUrl);

if (!urls.separate) {
  process.stderr.write(`WARNING: ${SINGLE_DATABASE_URL_WARNING}\n`);
} else {
  const { warning } = await provisionRuntimeRole(urls.migrationUrl, urls.url);
  if (warning) process.stderr.write(`WARNING: ${warning}\n`);
  else process.stdout.write(`Runtime login is ready (member of ${RUNTIME_ROLE}).\n`);
}
