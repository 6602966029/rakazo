#!/usr/bin/env node
// `pnpm dev`: start the API, worker, web app, and sandbox supervisor for this checkout.
//
// Several checkouts (git worktrees) can run at once. Each gets the first free block of ports,
// and all of them share one Postgres database unless this branch adds migrations that main
// does not have; those run against a database of the branch's own on the same server, so
// unmerged schema changes never reach the shared one.
//
// The database is `.env`'s DATABASE_URL when it accepts a connection. Otherwise a local
// Postgres container (`rakazo-dev-postgres`) is started and reused by every checkout.
// Setting WEB_PORT or API_PORT, in the shell or `.env`, turns off port selection.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPackage = path.join(root, "packages/db");
const require = createRequire(path.join(dbPackage, "package.json"));
const { Client } = require("pg");
const dotenv = require("dotenv");

const DEFAULT_PORTS = { web: 5173, api: 3100, supervisor: 7091 };
const PORT_STEP = 10;
const MANAGED = {
  container: "rakazo-dev-postgres",
  image: "postgres:18",
  port: 54318,
  owner: "rakazo",
  runtime: "rakazo_dev",
  database: "rakazo",
};
const SERVICES = ["@rakazo/api", "@rakazo/worker", "@rakazo/web", "@rakazo/sandbox-supervisor"];

const fileEnv = existsSync(path.join(root, ".env"))
  ? dotenv.parse(readFileSync(path.join(root, ".env")))
  : {};
const setting = (name) => process.env[name] ?? fileEnv[name];
const log = (message) => process.stdout.write(`[dev] ${message}\n`);

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: "pipe", ...options }).trim();
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function choosePorts() {
  for (let block = 0; block < 50; block += 1) {
    const ports = Object.fromEntries(
      Object.entries(DEFAULT_PORTS).map(([name, port]) => [name, port + block * PORT_STEP]),
    );
    const free = await Promise.all(Object.values(ports).map(portFree));
    if (free.every(Boolean)) return ports;
  }
  throw new Error("No free port block found near the defaults. Set WEB_PORT and API_PORT in .env.");
}

function portEnv({ web, api, supervisor }) {
  const webUrl = `http://127.0.0.1:${web}`;
  const apiUrl = `http://127.0.0.1:${api}`;
  return {
    WEB_PORT: String(web),
    WEB_ORIGIN: webUrl,
    BETTER_AUTH_URL: webUrl,
    API_PORT: String(api),
    API_URL: apiUrl,
    API_PROXY_TARGET: apiUrl,
    SUPERVISOR_PORT: String(supervisor),
    SANDBOX_SUPERVISOR_URL: `http://127.0.0.1:${supervisor}`,
  };
}

async function connects(url) {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

function withDatabase(url, database) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function startManagedPostgres() {
  try {
    run("docker", ["version", "--format", "{{.Server.Version}}"]);
  } catch {
    throw new Error(
      "DATABASE_URL in .env does not accept a connection and Docker is not running to start a local Postgres.",
    );
  }
  const state = (() => {
    try {
      return run("docker", ["inspect", "--format", "{{.State.Running}}", MANAGED.container]);
    } catch {
      return null;
    }
  })();
  if (state === null) {
    log(`Starting a shared Postgres container (${MANAGED.container})`);
    run("docker", [
      "run",
      "-d",
      "--name",
      MANAGED.container,
      "--restart",
      "unless-stopped",
      "-e",
      `POSTGRES_USER=${MANAGED.owner}`,
      // Development only: the container is published on loopback and holds throwaway data.
      "-e",
      `POSTGRES_PASSWORD=${MANAGED.owner}`,
      "-e",
      `POSTGRES_DB=${MANAGED.database}`,
      "-p",
      `127.0.0.1:${MANAGED.port}:5432`,
      "-v",
      `${MANAGED.container}:/var/lib/postgresql`,
      MANAGED.image,
    ]);
  } else if (state !== "true") {
    run("docker", ["start", MANAGED.container]);
  }
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      run("docker", ["exec", MANAGED.container, "pg_isready", "-q", "-U", MANAGED.owner]);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const server = `127.0.0.1:${MANAGED.port}`;
  return {
    url: `postgres://${MANAGED.runtime}:${MANAGED.runtime}@${server}/${MANAGED.database}`,
    migrationUrl: `postgres://${MANAGED.owner}:${MANAGED.owner}@${server}/${MANAGED.database}`,
  };
}

async function sharedDatabase() {
  const url = setting("DATABASE_URL");
  const migrationUrl = setting("DATABASE_MIGRATION_URL") || url;
  if (url && (await connects(migrationUrl))) return { url, migrationUrl };
  if (url) log("DATABASE_URL in .env does not accept a connection; using the local container");
  return startManagedPostgres();
}

/** Migrations in this checkout that origin/main does not have. */
function branchOnlyMigrations() {
  const dir = path.join(dbPackage, "prisma/migrations");
  const local = readdirSync(dir).filter((name) => statSync(path.join(dir, name)).isDirectory());
  let onMain;
  try {
    onMain = new Set(
      run("git", ["ls-tree", "--name-only", "origin/main", "packages/db/prisma/migrations/"], {
        cwd: root,
      })
        .split("\n")
        .map((entry) => path.basename(entry)),
    );
  } catch {
    return [];
  }
  return local.filter((name) => !onMain.has(name));
}

function branchSlug() {
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root });
  return branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

async function branchDatabase(shared) {
  const sharedName = new URL(shared.migrationUrl).pathname.slice(1);
  const name = `${sharedName}_${branchSlug()}`;
  const owner = new Client({ connectionString: shared.migrationUrl });
  await owner.connect();
  try {
    const exists = await owner.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (!exists.rowCount) {
      try {
        // A copy keeps your accounts and bots; it needs no open connections to the source.
        await owner.query(`CREATE DATABASE "${name}" TEMPLATE "${sharedName}"`);
        log(`Copied the shared database to ${name}`);
      } catch {
        await owner.query(`CREATE DATABASE "${name}"`);
        log(`Created an empty ${name} (the shared one was in use, so it could not be copied)`);
      }
    }
  } finally {
    await owner.end();
  }
  return {
    url: withDatabase(shared.url, name),
    migrationUrl: withDatabase(shared.migrationUrl, name),
  };
}

function generateClientIfStale(env) {
  const client = path.join(dbPackage, "src/generated/prisma/client.ts");
  const schema = path.join(dbPackage, "prisma/schema.prisma");
  if (existsSync(client) && statSync(client).mtimeMs >= statSync(schema).mtimeMs) return;
  log("Generating the Prisma client");
  execFileSync("pnpm", ["--filter", "@rakazo/db", "generate"], {
    cwd: root,
    env,
    stdio: "inherit",
  });
}

const env = { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };

let ports = null;
if (!setting("WEB_PORT") && !setting("API_PORT")) {
  ports = await choosePorts();
  Object.assign(env, portEnv(ports));
}

let database = await sharedDatabase();
const pending = branchOnlyMigrations();
if (pending.length) {
  log(`This branch adds ${pending.length} migration(s), so it gets its own database`);
  database = await branchDatabase(database);
}
env.DATABASE_URL = database.url;
env.DATABASE_MIGRATION_URL = database.migrationUrl;

generateClientIfStale(env);
execFileSync("pnpm", ["db:migrate"], { cwd: root, env, stdio: "inherit" });

if (ports) log(`Open http://127.0.0.1:${ports.web}`);
const turbo = spawn(
  "pnpm",
  ["exec", "turbo", "dev", "--env-mode=loose", ...SERVICES.map((name) => `--filter=${name}`)],
  { cwd: root, env, stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => turbo.kill(signal));
turbo.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
