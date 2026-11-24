import NoQL from "@synatic/noql";
import { MongoClient, type Db, type Document } from "mongodb";
import { MAX_RESULT_ROWS, MAX_SAMPLE_ROWS, QUERY_TIMEOUT_MS } from "../config.js";
import { SQLException } from "../exceptions/SQLException.js";
import { publicLookup } from "../net/public-host.js";
import type { AgentDatabaseRuntime, DatabaseCatalogColumn, DatabaseCatalogTable } from "../types.js";
import {
  MAX_LISTED_VALUES,
  collectSampleValues,
  completeValueList,
  normalizeName,
  sanitizeRow,
  shouldListValues,
} from "./sanitize.js";
import type { QueryResult } from "./types.js";

// MongoDB has no read-only transaction, so the boundary is narrower than for
// Postgres: the model writes SQL, NoQL turns it into an aggregation pipeline,
// the pipeline is checked for stages that write or run JavaScript, and only
// `aggregate` is ever called. Users are told to connect with a `read` role.

/**
 * Connection-string options a user may set. Everything else is refused:
 * MONGODB-AWS and MONGODB-OIDC would authenticate with this process's own
 * cloud credentials, tls*File options name files on this machine, and proxy
 * options would dial through a host the network guard never sees.
 */
const ALLOWED_OPTIONS = new Set(
  [
    "authSource",
    "authMechanism",
    "replicaSet",
    "tls",
    "ssl",
    "retryWrites",
    "retryReads",
    "readPreference",
    "appName",
    "w",
    "directConnection",
    "loadBalanced",
    "compressors",
    "connectTimeoutMS",
    "readConcernLevel",
  ].map((name) => name.toLowerCase()),
);
const ALLOWED_AUTH_MECHANISMS = new Set(["DEFAULT", "SCRAM-SHA-1", "SCRAM-SHA-256"]);
const CONNECTION_STRING = /^mongodb(?:\+srv)?:\/\/[^/?]+(?:\/([^?]*))?(?:\?(.*))?$/;

/**
 * The database a connection string names, after checking its options.
 * Throws on anything this service will not dial.
 */
export function mongoDatabaseName(connectionString: string): string {
  const match = CONNECTION_STRING.exec(connectionString.trim());
  if (!match) {
    throw new SQLException("The connection string must start with mongodb:// or mongodb+srv://.");
  }
  const database = decodeURIComponent(match[1] ?? "");
  if (!database) {
    throw new SQLException("The connection string must name a database, e.g. mongodb+srv://user:pass@host/shop.");
  }
  for (const [key, value] of new URLSearchParams(match[2] ?? "")) {
    if (!ALLOWED_OPTIONS.has(key.toLowerCase())) {
      throw new SQLException(`The connection option "${key}" is not supported.`);
    }
    if (key.toLowerCase() === "authmechanism" && !ALLOWED_AUTH_MECHANISMS.has(value.toUpperCase())) {
      throw new SQLException(`The authentication mechanism "${value}" is not supported. Use SCRAM (username and password).`);
    }
  }
  return database;
}

// One client per connection string, least-recently-used first, bounded like
// the Postgres pools in query.ts.
const CLIENT_MAX = 32;
const clients = new Map<string, MongoClient>();

function getClient(connectionString: string): MongoClient {
  const existing = clients.get(connectionString);
  if (existing) {
    clients.delete(connectionString);
    clients.set(connectionString, existing);
    return existing;
  }

  const client = new MongoClient(connectionString, {
    maxPoolSize: 5,
    connectTimeoutMS: 10_000,
    serverSelectionTimeoutMS: 10_000,
    readPreference: "secondaryPreferred",
    // Every socket the driver opens, SRV targets included, resolves through
    // the private-network guard.
    lookup: publicLookup,
  });
  clients.set(connectionString, client);

  while (clients.size > CLIENT_MAX) {
    const oldest = clients.entries().next();
    if (oldest.done) break;
    clients.delete(oldest.value[0]);
    void oldest.value[1].close().catch(() => undefined);
  }
  return client;
}

function openDatabase(database: AgentDatabaseRuntime): Db {
  const connectionString = database.connectionString;
  if (!connectionString) {
    throw new SQLException("MongoDB runtime is missing connectionString.");
  }
  const name = mongoDatabaseName(connectionString);
  return getClient(connectionString).db(name);
}

/** Stages and operators that write, or run server-side JavaScript. */
const BLOCKED_OPERATORS = new Set(["$out", "$merge", "$function", "$accumulator", "$where"]);

export function assertReadOnlyPipeline(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertReadOnlyPipeline);
    return;
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, child] of Object.entries(value)) {
      if (BLOCKED_OPERATORS.has(key)) {
        throw new SQLException(`Unsafe operation ${key} was blocked before execution.`);
      }
      assertReadOnlyPipeline(child);
    }
  }
}

/** SQL to the collection it runs against and the pipeline to run. */
export function translateSql(sql: string): { collections: string[]; pipeline: Document[] } {
  const parsed = NoQL.makeMongoAggregate(sql, { unsetId: true });
  assertReadOnlyPipeline(parsed.pipeline);
  return { collections: parsed.collections, pipeline: parsed.pipeline as Document[] };
}

/** BSON values to what the rest of the agent (and JSON) understands. */
export function toPlain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toPlain);
  if (value === null || typeof value !== "object" || value instanceof Date) return value;
  switch ((value as { _bsontype?: string })._bsontype) {
    case "ObjectId":
      return (value as { toHexString(): string }).toHexString();
    case "Decimal128":
    case "Long":
    case "Double":
    case "Int32":
      return Number(String(value));
    case "Binary":
      return `[binary:${(value as { length(): number }).length()}]`;
    case undefined:
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toPlain(child)]));
    default:
      return String(value);
  }
}

export async function runMongoQuery(database: AgentDatabaseRuntime, sql: string): Promise<QueryResult> {
  const db = openDatabase(database);
  const { collections, pipeline } = translateSql(sql);

  // An aggregate over a collection that does not exist returns no rows rather
  // than an error. Report it the way Postgres would, so the usual unknown-table
  // repair (including the free near-match fix) applies.
  const existing = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((collection) => collection.name),
  );
  const missing = collections.find((name) => !existing.has(name));
  if (missing) {
    throw new SQLException(`relation "${missing}" does not exist`, sql);
  }

  // ponytail: rowCount is the rows kept, not the true total. Add a $count
  // facet if the UI ever needs "200 of N" for MongoDB.
  const documents = await db
    .collection(collections[0]!)
    .aggregate([...pipeline, { $limit: MAX_RESULT_ROWS }], { maxTimeMS: QUERY_TIMEOUT_MS })
    .toArray();
  const rows = documents.map((document) => sanitizeRow(toPlain(document) as Record<string, unknown>));
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return { rowCount: rows.length, columns, rows };
}

const SAMPLE_DOCUMENTS = 100;
/** ponytail: wide documents are cut here; raise it or subset the catalog if real sources hit it. */
const MAX_FIELDS = 100;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * Nested sub-documents become dot paths (`address.city`), which NoQL accepts
 * as column names. Arrays stay one field: reaching into them needs UNWIND.
 */
export function flattenDocument(document: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    const path = prefix + key;
    if (isPlainObject(value) && Object.keys(value).length > 0) {
      Object.assign(flat, flattenDocument(value, `${path}.`));
    } else {
      flat[path] = value;
    }
  }
  return flat;
}

function bsonTypeName(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return "date";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "double";
  if (typeof value === "bigint") return "long";
  const bsonType = (value as { _bsontype?: string })._bsontype;
  if (bsonType === "ObjectId") return "objectId";
  if (bsonType === "Decimal128") return "decimal";
  if (bsonType === "Binary") return "binData";
  return bsonType ? bsonType.toLowerCase() : "object";
}

/** Columns from sampled documents: the most common type wins, and a field missing from any sample is nullable. */
export function inferColumns(documents: Array<Record<string, unknown>>): Array<Omit<DatabaseCatalogColumn, "sampleValues">> {
  const fields = new Map<string, { types: Map<string, number>; present: number }>();
  for (const document of documents) {
    for (const [path, value] of Object.entries(flattenDocument(document))) {
      const field = fields.get(path) ?? { types: new Map(), present: 0 };
      fields.set(path, field);
      const type = bsonTypeName(value);
      if (type) {
        field.present += 1;
        field.types.set(type, (field.types.get(type) ?? 0) + 1);
      }
    }
  }

  const ordered = [...fields.keys()].sort((a, b) => (a === "_id" ? -1 : b === "_id" ? 1 : 0)).slice(0, MAX_FIELDS);
  return ordered.map((path, index) => {
    const field = fields.get(path)!;
    const dataType = [...field.types.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "null";
    return {
      name: path,
      normalizedName: normalizeName(path),
      dataType,
      isNullable: field.present < documents.length,
      isPrimaryKey: path === "_id",
      ordinalPosition: index + 1,
    };
  });
}

async function listMongoValues(db: Db, collection: string, path: string): Promise<string[] | null> {
  try {
    const rows = await db
      .collection(collection)
      .aggregate(
        [{ $match: { [path]: { $type: "string" } } }, { $group: { _id: `$${path}` } }, { $limit: MAX_LISTED_VALUES + 1 }],
        { maxTimeMS: QUERY_TIMEOUT_MS },
      )
      .toArray();
    return completeValueList(rows.map((row) => row._id));
  } catch {
    return null;
  }
}

export async function introspectMongo(database: AgentDatabaseRuntime): Promise<DatabaseCatalogTable[]> {
  const db = openDatabase(database);
  const collections = (await db.listCollections({}, { nameOnly: false }).toArray())
    .filter((collection) => !collection.name.startsWith("system."))
    .sort((a, b) => a.name.localeCompare(b.name));

  const tables: DatabaseCatalogTable[] = [];
  for (const { name, type } of collections) {
    const collection = db.collection(name);
    const rowCount =
      type === "view"
        ? null
        : await collection.estimatedDocumentCount({ maxTimeMS: QUERY_TIMEOUT_MS }).catch(() => null);
    const documents = await collection
      .aggregate([{ $sample: { size: SAMPLE_DOCUMENTS } }], { maxTimeMS: QUERY_TIMEOUT_MS })
      .toArray();
    const sampleRows = documents
      .slice(0, MAX_SAMPLE_ROWS)
      .map((document) => sanitizeRow(toPlain(flattenDocument(document)) as Record<string, unknown>));
    const indexes = type === "view" ? [] : await collection.listIndexes().toArray().catch(() => []);

    const columns: DatabaseCatalogColumn[] = [];
    for (const column of inferColumns(documents)) {
      const listed = shouldListValues(column, rowCount) ? await listMongoValues(db, name, column.name) : null;
      columns.push({ ...column, sampleValues: listed ?? collectSampleValues(sampleRows, column.name) });
    }

    tables.push({
      schemaName: null,
      name,
      rowCount,
      sampleRows,
      columns,
      indexes: indexes.map((index) => ({
        name: String(index.name),
        columns: Object.keys(index.key ?? {}),
        isUnique: Boolean(index.unique) || index.name === "_id_",
        isPrimary: index.name === "_id_",
      })),
      foreignKeys: [],
    });
  }
  return tables;
}
