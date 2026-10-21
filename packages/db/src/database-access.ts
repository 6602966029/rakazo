import { Client, escapeIdentifier, escapeLiteral } from "pg";
import type { PrismaClient } from "./generated/prisma/client.js";

/**
 * NOLOGIN group role created by the row-level security migration. It holds the
 * runtime grants; the login in DATABASE_URL is this role or a member of it.
 */
export const RUNTIME_ROLE = "rakazo_app";

export interface DatabaseUrls {
  /** What the API and worker connect with. */
  url: string;
  /** What migrations run with: DATABASE_MIGRATION_URL, else DATABASE_URL. */
  migrationUrl: string;
  /** False when migrations and the app share one login, so policies are bypassed. */
  separate: boolean;
}

export function databaseUrls(env: Record<string, string | undefined>): DatabaseUrls {
  const url = env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is required");
  const migrationUrl = env.DATABASE_MIGRATION_URL?.trim() || url;
  return { url, migrationUrl, separate: loginOf(url) !== loginOf(migrationUrl) };
}

function loginOf(url: string): string {
  return decodeURIComponent(new URL(url).username);
}

export const SINGLE_DATABASE_URL_WARNING =
  "DATABASE_URL is used for both migrations and the app, so row-level security is not enforced. Set DATABASE_MIGRATION_URL to the owner role and DATABASE_URL to a runtime login (docs/self-host.md#database-roles).";

/**
 * Create or update the runtime login named in `runtimeUrl` and give it the
 * runtime grants. Runs as the migration (owner) role after migrations, so a
 * password change in DATABASE_URL takes effect on the next deploy. A login
 * that is a superuser or bypasses RLS is left alone and reported instead.
 */
export async function provisionRuntimeRole(
  migrationUrl: string,
  runtimeUrl: string,
): Promise<{ warning?: string }> {
  const owner = new Client({ connectionString: migrationUrl });
  await owner.connect();
  try {
    return await provisionWith(owner, runtimeUrl);
  } finally {
    await owner.end();
  }
}

async function provisionWith(owner: Client, runtimeUrl: string): Promise<{ warning?: string }> {
  const parsed = new URL(runtimeUrl);
  const login = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  if (!login) throw new Error("DATABASE_URL must name the runtime login");
  // The migration creates the role and grants too; repeating them here covers a
  // restore into a fresh cluster (roles are not in a database dump) and tables
  // another role created.
  const group = await owner.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [RUNTIME_ROLE]);
  if (!group.rowCount) {
    await owner
      .query(`CREATE ROLE ${RUNTIME_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`)
      .catch((error: unknown) => {
        throw new Error(
          `Could not create role ${RUNTIME_ROLE}; the migration role needs CREATEROLE, or create it NOLOGIN NOBYPASSRLS yourself`,
          { cause: error },
        );
      });
  }
  await owner.query(`
    GRANT USAGE ON SCHEMA public TO ${RUNTIME_ROLE};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RUNTIME_ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RUNTIME_ROLE};
    REVOKE ALL ON TABLE "_prisma_migrations" FROM ${RUNTIME_ROLE};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${RUNTIME_ROLE};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${RUNTIME_ROLE};
  `);
  await owner.query(
    `DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${RUNTIME_ROLE}', current_database()); END $$`,
  );
  // graphile-worker's schema is installed by the job queue migration that runs
  // just before this, so its grants cannot live in a Prisma migration.
  await owner.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'graphile_worker') THEN
        GRANT USAGE ON SCHEMA graphile_worker TO ${RUNTIME_ROLE};
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA graphile_worker TO ${RUNTIME_ROLE};
        GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA graphile_worker TO ${RUNTIME_ROLE};
        GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA graphile_worker TO ${RUNTIME_ROLE};
      END IF;
    END $$;
  `);
  const existing = await owner.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1",
    [login],
  );
  const role = existing.rows[0];
  if (role && (role.rolsuper || role.rolbypassrls)) {
    return {
      warning: `DATABASE_URL logs in as ${login}, which ${role.rolsuper ? "is a superuser" : "bypasses row-level security"}; row-level security is not enforced.`,
    };
  }
  const [admin] = (
    await owner.query<{ can: boolean; superuser: boolean }>(
      "SELECT rolsuper OR rolcreaterole AS can, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user",
    )
  ).rows;
  if (!admin?.can) {
    // Managed Postgres may not give the owner CREATEROLE. A login created and
    // granted rakazo_app by an administrator is used as it is.
    const member = role
      ? (
          await owner.query<{ member: boolean }>("SELECT pg_has_role($1, $2, 'MEMBER') AS member", [
            login,
            RUNTIME_ROLE,
          ])
        ).rows[0]?.member
      : false;
    if (member) return {};
    throw new Error(
      `The migration role cannot create logins. Create ${login} (LOGIN NOBYPASSRLS) and GRANT ${RUNTIME_ROLE} TO it, then deploy again.`,
    );
  }
  const name = escapeIdentifier(login);
  const secret = password ? `PASSWORD ${escapeLiteral(password)}` : "";
  // Only a superuser may set SUPERUSER, BYPASSRLS or REPLICATION, even to false. A
  // CREATEROLE owner leaves them at their defaults (off), and a login that already has
  // one of them was returned above.
  const limits = admin.superuser
    ? "NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION"
    : "";
  if (!role) await owner.query(`CREATE ROLE ${name} LOGIN ${secret} ${limits}`);
  else await owner.query(`ALTER ROLE ${name} LOGIN ${secret} ${limits}`);
  if (login !== RUNTIME_ROLE) await owner.query(`GRANT ${RUNTIME_ROLE} TO ${name}`);
  return {};
}

export interface RowSecurityStatus {
  enforced: boolean;
  role: string;
  reason?: string;
}

/** Whether the connected login is actually subject to the row-level security policies. */
export async function describeRowSecurity(prisma: PrismaClient): Promise<RowSecurityStatus> {
  const [row] = await prisma.$queryRawUnsafe<
    Array<{
      role: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      owns: boolean;
    }>
  >(`SELECT current_user AS role, r.rolsuper, r.rolbypassrls,
        pg_has_role(current_user, c.relowner, 'USAGE') AS owns
      FROM pg_roles r, pg_class c
      WHERE r.rolname = current_user AND c.oid = 'public.messages'::regclass`);
  if (!row) return { enforced: false, role: "unknown", reason: "could not read the role" };
  const reason = row.rolsuper
    ? "is a superuser"
    : row.rolbypassrls
      ? "has BYPASSRLS"
      : row.owns
        ? "owns the tables"
        : undefined;
  return { enforced: !reason, role: row.role, ...(reason ? { reason } : {}) };
}

/** The startup warning for a login that bypasses the policies, if any. */
export function rowSecurityWarning(status: RowSecurityStatus): string | undefined {
  if (status.enforced) return undefined;
  return `Row-level security is not enforced: the app connects as ${status.role}, which ${status.reason}. Point DATABASE_URL at a runtime login and DATABASE_MIGRATION_URL at the owner (docs/self-host.md#database-roles).`;
}
