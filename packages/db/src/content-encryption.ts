import type { ContentLocation, DataKey, SearchTokenDomain } from "./content-crypto.js";
import {
  ContentDecryptionError,
  ciphertextKeyId,
  decryptText,
  encryptText,
  jsonKeyIds,
  openJson,
  querySearchTokens,
  sealJson,
  searchTokens,
} from "./content-crypto.js";
import type { ContentKeyRing, SpaceSource } from "./content-keys.js";
import type { PrismaClient } from "./generated/prisma/client.js";
import { Prisma } from "./generated/prisma/client.js";
import { historyMessageText } from "./history-text.js";
import { createRowId } from "./row-id.js";

/**
 * Scalars that stay readable beside each sealed block because queries filter on
 * them (`array_contains`, `path`, artifact lookups). Everything else in a block,
 * including these values, is only authoritative inside the sealed copy.
 */
const MESSAGE_BLOCK_PLAIN_KEYS = new Set(["kind", "status", "channelId", "serverId", "artifactId"]);
/** Event payload keys that event queries filter on. */
const EVENT_PAYLOAD_PLAIN_KEYS = new Set([
  "messageId",
  "notice",
  "state",
  "updatedAt",
  "streaming",
]);

interface FieldSpec {
  /** Present for JSON columns: the scalar keys kept queryable beside the sealed copy. */
  plainKeys?: ReadonlySet<string>;
}

interface ModelSpec {
  table: SpaceSource;
  fields: Record<string, FieldSpec>;
  /** Where the owning space comes from: a column on the row, or a parent row. */
  space:
    | { column: "spaceId"; relation: "space" }
    | { column: "threadId" | "documentId"; relation: "thread" | "document"; parent: SpaceSource };
  searchTokens?: boolean;
}

/** Further content columns (external messages, steering, skills, …) add an entry here. */
export const ENCRYPTED_MODELS: Record<string, ModelSpec> = {
  Message: {
    table: "messages",
    fields: { blocks: { plainKeys: MESSAGE_BLOCK_PLAIN_KEYS } },
    space: { column: "threadId", relation: "thread", parent: "threads" },
    searchTokens: true,
  },
  Event: {
    table: "events",
    fields: { payload: { plainKeys: EVENT_PAYLOAD_PLAIN_KEYS } },
    space: { column: "spaceId", relation: "space" },
  },
  MemoryDocument: {
    table: "memory_documents",
    fields: { content: {} },
    space: { column: "spaceId", relation: "space" },
  },
  MemoryRevision: {
    table: "memory_revisions",
    fields: { content: {} },
    space: { column: "documentId", relation: "document", parent: "memory_documents" },
  },
  /** The compacted summary of older history is derived message content. */
  Thread: {
    table: "threads",
    fields: { historyCompactionSummary: {} },
    space: { column: "spaceId", relation: "space" },
  },
};

/** Rows whose id → space mapping the ring learns from results, for child writes. */
const PARENT_SOURCES: Record<string, SpaceSource> = {
  Thread: "threads",
  MemoryDocument: "memory_documents",
  Event: "events",
};

type RecordValue = Record<string, unknown>;
type RuntimeDataModel = {
  models: Record<string, { fields: Array<{ name: string; kind: string; type: string }> }>;
};

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Nulls (SQL or JSON) are stored as nulls: there is nothing to encrypt. */
function writable(value: unknown): boolean {
  return (
    value !== undefined &&
    value !== null &&
    value !== Prisma.DbNull &&
    value !== Prisma.JsonNull &&
    value !== Prisma.AnyNull
  );
}

function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, out);
  else if (isRecord(value)) for (const item of Object.values(value)) stringsIn(item, out);
  return out;
}

export interface ContentEncryption {
  ring: ContentKeyRing;
  /** Decrypts rows read with raw SQL. Rows must include `id`. */
  openRows<T extends { id: string }>(model: keyof typeof ENCRYPTED_MODELS, rows: T[]): Promise<T[]>;
  /** One token list per key version of the space; a match must contain every token of one list. */
  messageSearchTokens(
    spaceId: string,
    query: string,
    domain: SearchTokenDomain,
  ): Promise<number[][]>;
}

/** Undefined for clients built without content encryption (fakes and temp-table tests). */
export function contentEncryptionOf(prisma: unknown): ContentEncryption | undefined {
  const accessor = (prisma as { $contentEncryption?: () => ContentEncryption } | null)
    ?.$contentEncryption;
  return typeof accessor === "function" ? accessor.call(prisma) : undefined;
}

interface Plan {
  model: string;
  stripId: boolean;
  relations: Map<string, Plan>;
}

const NESTED_WRITES = ["create", "createMany", "connectOrCreate", "upsert", "update", "updateMany"];
const NO_ROWS = new Set([
  "count",
  "aggregate",
  "groupBy",
  "createMany",
  "updateMany",
  "deleteMany",
]);

/**
 * Encrypts user content at the data-access layer. Writes to the columns in
 * ENCRYPTED_MODELS are sealed with the owning space's current key; reads decrypt
 * anywhere the rows appear, including nested `include`/`select`. Plaintext rows
 * from before the migration read unchanged. Nested writes into encrypted models
 * are rejected rather than silently stored in plaintext. Raw SQL is the one
 * bypass: callers that read these columns with `$queryRaw` use `openRows`.
 */
export function withContentEncryption(prisma: PrismaClient, ring: ContentKeyRing): PrismaClient {
  const dataModel = (prisma as unknown as { _runtimeDataModel?: RuntimeDataModel })
    ._runtimeDataModel;
  if (!dataModel?.models) throw new Error("Prisma runtime data model is unavailable");
  const relations = new Map<string, Map<string, string>>();
  for (const [model, { fields }] of Object.entries(dataModel.models))
    relations.set(
      model,
      new Map(
        fields.filter((field) => field.kind === "object").map((field) => [field.name, field.type]),
      ),
    );
  const relationTarget = (model: string, field: string) => relations.get(model)?.get(field);

  function plan(model: string, args: RecordValue | undefined): { args: RecordValue; plan?: Plan } {
    const spec = ENCRYPTED_MODELS[model];
    const next: RecordValue = { ...args };
    const result: Plan = { model, stripId: false, relations: new Map() };
    const walk = (selection: RecordValue) => {
      for (const [field, value] of Object.entries(selection)) {
        const target = relationTarget(model, field);
        if (!target || !value) continue;
        const child = plan(target, isRecord(value) ? value : undefined);
        if (!child.plan) continue;
        result.relations.set(field, child.plan);
        selection[field] = Object.keys(child.args).length ? child.args : value;
      }
    };
    if (isRecord(next.select)) {
      const select = { ...next.select };
      walk(select);
      if (spec && !select.id && Object.keys(spec.fields).some((field) => select[field])) {
        select.id = true;
        result.stripId = true;
      }
      next.select = select;
    } else {
      if (spec) {
        const omit: RecordValue = isRecord(next.omit) ? { ...next.omit } : {};
        if (spec.searchTokens && omit.searchTokens === undefined) omit.searchTokens = true;
        if (omit.id) {
          delete omit.id;
          result.stripId = true;
        }
        if (Object.keys(omit).length) next.omit = omit;
        else delete next.omit;
      }
      if (isRecord(next.include)) {
        const include = { ...next.include };
        walk(include);
        next.include = include;
      }
    }
    const relevant = Boolean(spec) || model in PARENT_SOURCES || result.relations.size > 0;
    return { args: next, plan: relevant ? result : undefined };
  }

  type Pending = { row: RecordValue; spec: ModelSpec };
  type Collected = { pending: Pending[]; strip: RecordValue[] };
  function collect(value: unknown, node: Plan, out: Collected) {
    if (Array.isArray(value)) {
      for (const item of value) collect(item, node, out);
      return;
    }
    if (!isRecord(value)) return;
    const spec = ENCRYPTED_MODELS[node.model];
    if (spec) out.pending.push({ row: value, spec });
    const source = PARENT_SOURCES[node.model];
    if (source && typeof value.id === "string" && typeof value.spaceId === "string")
      ring.remember(source, value.id, value.spaceId);
    for (const [field, child] of node.relations) collect(value[field], child, out);
    if (node.stripId) out.strip.push(value);
  }

  async function openAll(value: unknown, node: Plan) {
    const collected: Collected = { pending: [], strip: [] };
    collect(value, node, collected);
    await open(collected.pending);
    for (const row of collected.strip) delete row.id;
  }

  function keyIdsOf(pending: Pending): string[] {
    return Object.entries(pending.spec.fields).flatMap(([field, spec]) => {
      const value = pending.row[field];
      if (spec.plainKeys) return jsonKeyIds(value);
      const id = ciphertextKeyId(value);
      return id ? [id] : [];
    });
  }

  async function open(pending: Pending[]) {
    const ids = [...new Set(pending.flatMap(keyIdsOf))];
    const keys = new Map(
      await Promise.all(ids.map(async (id) => [id, await ring.byId(id)] as const)),
    );
    for (const { row, spec } of pending) {
      const rowKeyIds = keyIdsOf({ row, spec });
      if (!rowKeyIds.length) continue;
      if (typeof row.id !== "string")
        throw new ContentDecryptionError("Encrypted rows need their id");
      const rowId = row.id;
      for (const [field, fieldSpec] of Object.entries(spec.fields)) {
        if (!(field in row)) continue;
        const location: ContentLocation = { table: spec.table, column: field, rowId };
        const decrypt = (ciphertext: string) => {
          const key = keys.get(ciphertextKeyId(ciphertext)!)!;
          if (
            spec.space.column === "spaceId" &&
            typeof row.spaceId === "string" &&
            row.spaceId !== key.spaceId
          )
            throw new ContentDecryptionError("Encrypted content belongs to another space");
          return decryptText(key, location, ciphertext);
        };
        const value = row[field];
        row[field] = fieldSpec.plainKeys
          ? openJson(value, decrypt)
          : ciphertextKeyId(value)
            ? decrypt(value as string)
            : value;
      }
      ring.remember(spec.table, rowId, keys.get(rowKeyIds[0]!)!.spaceId);
    }
  }

  async function seal(spec: ModelSpec, data: RecordValue, rowId: string, spaceId: string) {
    const fields = Object.keys(spec.fields).filter((field) => writable(data[field]));
    if (!fields.length) return data;
    const key: DataKey = await ring.current(spaceId);
    const next = { ...data };
    for (const field of fields) {
      const location: ContentLocation = { table: spec.table, column: field, rowId };
      const encrypt = (plaintext: string) => encryptText(key, location, plaintext);
      const plainKeys = spec.fields[field]!.plainKeys;
      let value = next[field];
      if (!plainKeys && isRecord(value) && "set" in value) value = value.set;
      if (value === null) next[field] = null;
      else if (plainKeys) {
        if (spec.searchTokens)
          next.searchTokens = searchTokens(key, {
            words: historyMessageText(value as Prisma.JsonValue),
            strings: stringsIn(value),
          });
        next[field] = sealJson(value, plainKeys, encrypt);
      } else if (typeof value === "string") next[field] = encrypt(value);
      else throw new Error(`Unsupported write to encrypted ${spec.table}.${field}`);
    }
    ring.remember(spec.table, rowId, spaceId);
    return next;
  }

  function touches(spec: ModelSpec, data: unknown): boolean {
    return isRecord(data) && Object.keys(spec.fields).some((field) => writable(data[field]));
  }

  function assertNoNestedEncryptedWrites(model: string, data: unknown) {
    for (const item of Array.isArray(data) ? data : [data]) {
      if (!isRecord(item)) continue;
      for (const [field, value] of Object.entries(item)) {
        const target = relationTarget(model, field);
        if (!target || !isRecord(value)) continue;
        for (const operation of NESTED_WRITES) {
          const nested = value[operation];
          if (nested === undefined) continue;
          const payloads = (Array.isArray(nested) ? nested : [nested]).flatMap((entry) =>
            isRecord(entry) ? [entry.data, entry.create, entry.update, entry] : [],
          );
          const spec = ENCRYPTED_MODELS[target];
          if (spec && payloads.some((payload) => touches(spec, payload)))
            throw new Error(`Write encrypted ${target} rows directly, not through a nested write`);
          for (const payload of payloads) assertNoNestedEncryptedWrites(target, payload);
        }
      }
    }
  }

  async function createSpace(spec: ModelSpec, data: RecordValue): Promise<string> {
    const relation = data[spec.space.relation];
    const connected =
      isRecord(relation) && isRecord(relation.connect) ? relation.connect.id : undefined;
    const id = data[spec.space.column] ?? connected;
    if (typeof id !== "string")
      throw new Error(`Encrypted ${spec.table} writes must name their ${spec.space.column}`);
    return "parent" in spec.space ? ring.spaceOf(spec.space.parent, id) : id;
  }

  async function sealCreate(spec: ModelSpec, data: unknown): Promise<unknown> {
    if (!isRecord(data) || !touches(spec, data)) return data;
    const row = { ...data, id: typeof data.id === "string" ? data.id : createRowId() };
    return seal(spec, row, row.id, await createSpace(spec, row));
  }

  async function sealWrites(
    model: string,
    operation: string,
    args: RecordValue,
  ): Promise<RecordValue> {
    if (
      [
        "create",
        "createMany",
        "createManyAndReturn",
        "update",
        "updateMany",
        "updateManyAndReturn",
        "upsert",
      ].includes(operation)
    ) {
      assertNoNestedEncryptedWrites(model, args.data);
      if (operation === "upsert") {
        assertNoNestedEncryptedWrites(model, args.create);
        assertNoNestedEncryptedWrites(model, args.update);
      }
    }
    const spec = ENCRYPTED_MODELS[model];
    if (!spec) return args;
    if (operation === "create") return { ...args, data: await sealCreate(spec, args.data) };
    if (operation === "createMany" || operation === "createManyAndReturn") {
      const data = Array.isArray(args.data)
        ? await Promise.all(args.data.map((row) => sealCreate(spec, row)))
        : await sealCreate(spec, args.data);
      return { ...args, data };
    }
    if (operation === "upsert") {
      if (touches(spec, args.create) || touches(spec, args.update))
        throw new Error(`Upserts of encrypted ${model} content are not supported`);
      return args;
    }
    if (
      ["update", "updateMany", "updateManyAndReturn"].includes(operation) &&
      touches(spec, args.data)
    ) {
      const where = isRecord(args.where) ? args.where : {};
      if (typeof where.id !== "string")
        throw new Error(`Encrypted ${model} content must be updated by id`);
      const spaceId = await ring.spaceOf(spec.table, where.id);
      return { ...args, data: await seal(spec, args.data as RecordValue, where.id, spaceId) };
    }
    return args;
  }

  const handle: ContentEncryption = {
    ring,
    async openRows(model, rows) {
      await openAll(rows, { model, stripId: false, relations: new Map() });
      return rows;
    },
    async messageSearchTokens(spaceId, query, domain) {
      const keys = await ring.all(spaceId);
      return keys.map((key) => querySearchTokens(key, query, domain));
    },
  };

  return prisma.$extends({
    client: {
      $contentEncryption: () => handle,
    },
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (model === "Space" && ["delete", "deleteMany"].includes(operation)) {
            const where = (args as RecordValue).where;
            if (isRecord(where) && typeof where.id === "string") ring.forget(where.id);
          }
          let next = await sealWrites(model, operation, (args ?? {}) as RecordValue);
          if (NO_ROWS.has(operation)) return query(next);
          const planned = plan(model, next);
          if (!planned.plan) return query(next);
          next = planned.args;
          const result = await query(next);
          await openAll(result, planned.plan);
          return result;
        },
      },
    },
  }) as unknown as PrismaClient;
}
