import { BSON, MongoClient, type Db, type Document } from "mongodb";
import { MAX_RESULT_ROWS, MAX_SAMPLE_ROWS, QUERY_TIMEOUT_MS } from "../config.js";
import { SQLException } from "../exceptions/SQLException.js";
import { assertPublicHost, isBlockedLiteral, publicLookup } from "../net/public-host.js";
import type { AgentDatabaseRuntime, DatabaseCatalogColumn, DatabaseCatalogTable } from "../types.js";
import {
  MAX_LISTED_VALUES,
  SECRET_FIELD_PATTERN,
  collectSampleValues,
  completeValueList,
  sanitizeRow,
  shouldListValues,
} from "./sanitize.js";
import type { QueryResult } from "./types.js";

// MongoDB has no read-only transaction, so the boundary is narrower than for
// Postgres: the model writes a native aggregation query as JSON, the pipeline
// is checked for stages that write or run JavaScript, and only `aggregate` is
// ever called. Users are told to connect with a `read` role.

/**
 * Connection-string options a user may set. Everything else is refused:
 * MONGODB-AWS and MONGODB-OIDC would authenticate with this process's own
 * cloud credentials, tls*File options name files on this machine, and proxy
 * options would dial through a host the network guard never sees.
 * Pool and timeout options are accepted because app connection strings often
 * carry them; the client's own settings (getClient) win over the URI's.
 */
const ALLOWED_OPTIONS = new Set(
  [
    "maxPoolSize",
    "minPoolSize",
    "maxIdleTimeMS",
    "maxConnecting",
    "waitQueueTimeoutMS",
    "socketTimeoutMS",
    "serverSelectionTimeoutMS",
    "heartbeatFrequencyMS",
    "localThresholdMS",
    "maxStalenessSeconds",
    "readPreferenceTags",
    "journal",
    "wtimeoutMS",
    "zlibCompressionLevel",
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
// Not `new URL`: a replica-set string lists several host:port pairs.
const CONNECTION_STRING = /^mongodb(?:\+srv)?:\/\/(?:[^@/?]*@)?([^/?]+)(?:\/([^?]*))?(?:\?(.*))?$/;

type ParsedConnectionString = { database: string; hosts: string[] };

/**
 * The database and seed hosts a connection string names, after checking its
 * options. Throws on anything this service will not dial.
 */
export function parseMongoConnectionString(connectionString: string): ParsedConnectionString {
  const match = CONNECTION_STRING.exec(connectionString);
  if (!match) {
    throw new SQLException("The connection string must start with mongodb:// or mongodb+srv://.");
  }
  const database = decodeURIComponent(match[2] ?? "");
  if (!database) {
    throw new SQLException("The connection string must name a database, e.g. mongodb+srv://user:pass@host/shop.");
  }
  for (const [key, value] of new URLSearchParams(match[3] ?? "")) {
    if (!ALLOWED_OPTIONS.has(key.toLowerCase())) {
      throw new SQLException(`The connection option "${key}" is not supported.`);
    }
    if (key.toLowerCase() === "authmechanism" && !ALLOWED_AUTH_MECHANISMS.has(value.toUpperCase())) {
      throw new SQLException(`The authentication mechanism "${value}" is not supported. Use SCRAM (username and password).`);
    }
  }
  const hosts = match[1]!.split(",").map((entry) => {
    const host = hostOf(decodeURIComponent(entry));
    // The driver reads a host ending in .sock as a unix socket path.
    if (host.includes("/") || host.endsWith(".sock")) {
      throw new SQLException("Unix socket connections are not supported.");
    }
    return host;
  });
  return { database, hosts };
}

// One client per connection string, least-recently-used first, bounded like
// the Postgres pools in query.ts.
const CLIENT_MAX = 32;
const clients = new Map<string, MongoClient>();
/** Clients whose replica set announced a private address, with that address. */
const refused = new WeakMap<MongoClient, string>();

function dropClient(connectionString: string) {
  const client = clients.get(connectionString);
  clients.delete(connectionString);
  void client?.close().catch(() => undefined);
}

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
    // Every host name the driver dials, SRV targets included, resolves
    // through the private-network guard.
    lookup: publicLookup,
  });
  // A replica set announces its members, and an IP literal never reaches
  // `lookup`. A server that announces a private address loses its client.
  // ponytail: the driver opens the announced member's monitor socket right
  // after this event, so one heartbeat can reach it; queries cannot (see
  // assertTopologyPublic). Close that gap with a SOCKS5 shim on proxyHost if
  // a blind probe ever matters.
  client.on("serverOpening", (event) => {
    const host = hostOf(event.address);
    if (isBlockedLiteral(host)) {
      refused.set(client, host);
      dropClient(connectionString);
    }
  });
  clients.set(connectionString, client);

  while (clients.size > CLIENT_MAX) {
    const oldest = clients.keys().next();
    if (oldest.done) break;
    dropClient(oldest.value);
  }
  return client;
}

/** `host:port` or `[ipv6]:port` to the bare host. */
function hostOf(address: string): string {
  const bracketed = /^\[([^\]]+)\]/.exec(address);
  return bracketed ? bracketed[1]! : address.replace(/:\d+$/, "");
}

/** Refuses to run anything on a client whose replica set announced a private address. */
function assertTopologyPublic(client: MongoClient) {
  const host = refused.get(client);
  if (host) {
    throw new SQLException(`"${host}" is a private or internal address and cannot be used here.`);
  }
}

async function openDatabase(database: AgentDatabaseRuntime): Promise<{ db: Db; client: MongoClient }> {
  const connectionString = database.connectionString?.trim();
  if (!connectionString) {
    throw new SQLException("MongoDB runtime is missing connectionString.");
  }
  const { database: name, hosts } = parseMongoConnectionString(connectionString);
  // Seed hosts given as IP literals skip `lookup`, so check them up front.
  await Promise.all(hosts.map(assertPublicHost));
  const client = getClient(connectionString);
  return { db: client.db(name), client };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

/** Stages and operators that write, or run server-side JavaScript. */
const BLOCKED_OPERATORS = new Set(["$out", "$merge", "$function", "$accumulator", "$where"]);

export function assertReadOnlyPipeline(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertReadOnlyPipeline);
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (BLOCKED_OPERATORS.has(key)) {
        throw new SQLException(`Unsafe operation ${key} was blocked before execution.`);
      }
      assertReadOnlyPipeline(child);
    }
  }
}

export type MongoQuery = { collection: string; pipeline: Document[] };

/**
 * The query text the model writes for MongoDB: Extended JSON of
 * `{"collection": "...", "pipeline": [...]}`, so `{"$oid": ...}` and
 * `{"$date": ...}` become real ObjectIds and dates.
 */
export function parseMongoQuery(text: string): MongoQuery {
  let value: unknown;
  try {
    value = BSON.EJSON.parse(text, { relaxed: true });
  } catch (error) {
    throw new SQLException(`syntax error: the query is not valid JSON (${(error as Error).message}).`, text);
  }
  const query = value as Partial<MongoQuery> | null;
  if (
    !isPlainObject(query) ||
    typeof query.collection !== "string" ||
    !query.collection ||
    !Array.isArray(query.pipeline) ||
    !query.pipeline.every(isPlainObject)
  ) {
    throw new SQLException(
      'syntax error: the query must be a JSON object {"collection": "<name>", "pipeline": [<stages>]}.',
      text,
    );
  }
  assertReadOnlyPipeline(query.pipeline);
  return { collection: query.collection, pipeline: query.pipeline as Document[] };
}

/** Every collection a query reads: its own, and those of $lookup, $graphLookup and $unionWith. */
export function referencedCollections({ collection, pipeline }: MongoQuery): string[] {
  const names = new Set([collection]);
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!isPlainObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if ((key === "$lookup" || key === "$graphLookup") && isPlainObject(child) && typeof child.from === "string") {
        names.add(child.from);
      }
      if (key === "$unionWith") {
        const coll = typeof child === "string" ? child : isPlainObject(child) ? child.coll : null;
        if (typeof coll === "string") names.add(coll);
      }
      walk(child);
    }
  };
  walk(pipeline);
  return [...names];
}

/**
 * BSON values to what the rest of the agent (and JSON) understands. Documents
 * stay nested, so fields named like secrets are redacted at every depth, not
 * only at the top level `sanitizeRow` sees.
 */
export function toPlain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toPlain);
  if (value === null || typeof value !== "object" || value instanceof Date) return value;
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, SECRET_FIELD_PATTERN.test(key) ? "[redacted]" : toPlain(child)]),
    );
  }
  switch ((value as { _bsontype?: string })._bsontype) {
    case "ObjectId":
      return (value as { toHexString(): string }).toHexString();
    // ponytail: Decimal128 and Long past 2^53 lose precision as numbers.
    // Return the string form if money columns need exact cents.
    case "Decimal128":
    case "Long":
    case "Double":
    case "Int32":
      return Number(String(value));
    case "Binary":
      return `[binary:${(value as { length(): number }).length()}]`;
    default:
      return String(value);
  }
}

/** Code 50 is MaxTimeMSExpired. */
const MONGO_TIME_LIMIT = 50;

export async function runMongoQuery(database: AgentDatabaseRuntime, text: string): Promise<QueryResult> {
  const query = parseMongoQuery(text);
  const { db, client } = await openDatabase(database);

  // An aggregate over a collection that does not exist returns no rows rather
  // than an error. Report it the way Postgres would, so the usual unknown-table
  // repair (including the free near-match fix) applies.
  // ponytail: one listCollections round trip per query. Check against the
  // catalog instead if query latency on MongoDB ever shows it.
  const existing = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((collection) => collection.name),
  );
  const missing = referencedCollections(query).find((name) => !existing.has(name));
  if (missing) {
    throw new SQLException(`relation "${missing}" does not exist`, text);
  }
  assertTopologyPublic(client);

  let documents;
  try {
    // ponytail: rowCount is the rows kept, not the true total. Add a $count
    // facet if the UI ever needs "200 of N" for MongoDB.
    documents = await db
      .collection(query.collection)
      .aggregate([...query.pipeline, { $limit: MAX_RESULT_ROWS }], { maxTimeMS: QUERY_TIMEOUT_MS })
      .toArray();
  } catch (error) {
    if ((error as { code?: unknown })?.code === MONGO_TIME_LIMIT) {
      throw new SQLException(`The query ran longer than ${Math.round(QUERY_TIMEOUT_MS / 1000)}s and was cancelled.`, text);
    }
    throw error;
  }
  // Sub-documents become dot-path columns, as in the catalog, so the table
  // shows values rather than objects.
  const rows = documents.map((document) => sanitizeRow(flattenDocument(toPlain(document) as Record<string, unknown>)));
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return { rowCount: rows.length, columns, rows };
}

const SAMPLE_DOCUMENTS = 100;
/** ponytail: the rarest fields past this are dropped; subset the catalog instead if real sources hit it. */
const MAX_FIELDS = 100;

/**
 * Nested sub-documents become dot paths (`address.city`), the way a pipeline
 * names them. Arrays stay one field: reaching into them needs $unwind.
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

/**
 * Columns from sampled documents: the most common type wins, a field missing
 * from any sample is nullable, and when there are too many fields the rarest
 * are dropped. `_id` comes first, the rest keep the order they first appeared in.
 */
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

  const firstSeen = [...fields.keys()];
  const kept = new Set(
    [...firstSeen]
      .sort((a, b) => (a === "_id" ? -1 : b === "_id" ? 1 : fields.get(b)!.present - fields.get(a)!.present))
      .slice(0, MAX_FIELDS),
  );
  const ordered = firstSeen.filter((path) => kept.has(path)).sort((a, b) => (a === "_id" ? -1 : b === "_id" ? 1 : 0));
  return ordered.map((path, index) => {
    const field = fields.get(path)!;
    const dataType = [...field.types.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "null";
    return {
      name: path,
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
  const { db, client } = await openDatabase(database);
  const collections = (await db.listCollections({}, { nameOnly: false }).toArray())
    .filter((collection) => !collection.name.startsWith("system."))
    .sort((a, b) => a.name.localeCompare(b.name));
  assertTopologyPublic(client);

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
