import { createHash } from "node:crypto";
import type {
  DatabaseCatalogTable,
  DatabaseKnowledgeRuntime,
} from "../types.js";
import {
  IDENTIFIER_THRESHOLDS,
  type IdentifierMatchKind,
  bestMatch,
  identifierKey,
  identifierSimilarityDetail,
  identifierSortedKey,
  identifierTokens,
  normalizeIdentifier,
} from "./identifier-match.js";

/**
 * Lookup structure over the catalog that arrives with each request.
 *
 * The catalog itself is flat arrays of tables and columns, so every lookup used
 * to be an O(tables x columns) scan and nothing could answer "did you mean".
 * This builds the maps once per schema and adds fuzzy resolution on top.
 */

export type IndexedColumn = {
  /** Catalog-exact name. Never rewritten — this is what goes back into SQL. */
  name: string;
  normalized: string;
  key: string;
  sortedKey: string;
  tokens: string[];
  dataType: string;
  isNullable: boolean;
  isPrimaryKey: boolean;
  ordinalPosition: number;
  table: IndexedTable;
  /** `schema.table.column`, or `table.column` when the schema is unqualified. */
  qualifiedName: string;
};

export type IndexedTable = {
  name: string;
  schemaName: string | null;
  qualifiedName: string;
  normalized: string;
  key: string;
  sortedKey: string;
  tokens: string[];
  rowCount: number | null;
  columns: IndexedColumn[];
  columnByNormalized: Map<string, IndexedColumn>;
};

export type ColumnResolution = {
  candidate: string;
  column: IndexedColumn;
  table: IndexedTable;
  score: number;
  /** True when the candidate already names a real column, casing aside. */
  exact: boolean;
  matchKind: IdentifierMatchKind;
  /** A competing candidate scored close enough that picking one is a guess. */
  ambiguous: boolean;
  alternatives: Array<{ column: IndexedColumn; score: number }>;
};

export type TableResolution = {
  candidate: string;
  table: IndexedTable;
  score: number;
  exact: boolean;
  matchKind: IdentifierMatchKind;
  ambiguous: boolean;
  alternatives: Array<{ table: IndexedTable; score: number }>;
};

export type ResolveOptions = {
  /** Restricts resolution to one table when the caller knows the scope. */
  tableHint?: string | null;
  minScore?: number;
  maxAlternatives?: number;
};

export interface SchemaIndex {
  readonly fingerprint: string;
  readonly tables: IndexedTable[];
  readonly allColumns: IndexedColumn[];
  hasTable(name: string): boolean;
  hasColumn(name: string, tableHint?: string | null): boolean;
  getTable(name: string): IndexedTable | null;
  getColumn(name: string, tableHint?: string | null): IndexedColumn | null;
  resolveTable(candidate: string, options?: ResolveOptions): TableResolution | null;
  resolveColumn(candidate: string, options?: ResolveOptions): ColumnResolution | null;
  suggestColumns(
    candidate: string,
    limit?: number,
  ): Array<{ qualifiedName: string; score: number }>;
  suggestTables(
    candidate: string,
    limit?: number,
  ): Array<{ qualifiedName: string; score: number }>;
}

const DEFAULT_MAX_ALTERNATIVES = 3;
const EXACT_SCORE_FLOOR = 0.99;

/**
 * Stable identity for a catalog. Shared with the plan cache so the two cannot
 * disagree about which schema they are holding.
 */
export function computeSchemaIdentity(
  knowledge: DatabaseKnowledgeRuntime,
  fingerprint?: string | null,
): string {
  const explicit = fingerprint ?? knowledge.schemaFingerprint;
  if (explicit) {
    return explicit;
  }

  const tables = knowledge.tables.map((table) => ({
    n: table.name,
    s: table.schemaName ?? null,
    c: table.columns.map((column) => `${column.name}:${column.dataType}`),
  }));

  // NUL separator, matching the plan cache's existing hashing so identities
  // stay byte-compatible with keys already in flight.
  return createHash("sha256")
    .update(JSON.stringify(tables))
    .update("\0")
    .update(knowledge.summary ?? "")
    .digest("hex");
}

function qualifyTable(table: DatabaseCatalogTable): string {
  return table.schemaName ? `${table.schemaName}.${table.name}` : table.name;
}

class SchemaIndexImpl implements SchemaIndex {
  readonly fingerprint: string;
  readonly tables: IndexedTable[] = [];
  readonly allColumns: IndexedColumn[] = [];

  private readonly tableByNormalized = new Map<string, IndexedTable>();
  private readonly tableByQualified = new Map<string, IndexedTable>();
  private readonly columnsByName = new Map<string, IndexedColumn[]>();
  private readonly columnsByNormalized = new Map<string, IndexedColumn[]>();

  constructor(knowledge: DatabaseKnowledgeRuntime, fingerprint: string) {
    this.fingerprint = fingerprint;

    for (const catalogTable of knowledge.tables) {
      const qualifiedName = qualifyTable(catalogTable);
      const table: IndexedTable = {
        name: catalogTable.name,
        schemaName: catalogTable.schemaName ?? null,
        qualifiedName,
        normalized: normalizeIdentifier(catalogTable.name),
        key: identifierKey(catalogTable.name),
        sortedKey: identifierSortedKey(catalogTable.name),
        tokens: identifierTokens(catalogTable.name),
        rowCount: catalogTable.rowCount ?? null,
        columns: [],
        columnByNormalized: new Map(),
      };

      for (const catalogColumn of catalogTable.columns) {
        // normalizedName arrives pre-computed on the wire but may have been
        // produced by an older build, so it is recomputed here rather than
        // trusted.
        const normalized = normalizeIdentifier(catalogColumn.name);
        const column: IndexedColumn = {
          name: catalogColumn.name,
          normalized,
          key: identifierKey(catalogColumn.name),
          sortedKey: identifierSortedKey(catalogColumn.name),
          tokens: identifierTokens(catalogColumn.name),
          dataType: catalogColumn.dataType,
          isNullable: catalogColumn.isNullable,
          isPrimaryKey: catalogColumn.isPrimaryKey,
          ordinalPosition: catalogColumn.ordinalPosition,
          table,
          qualifiedName: `${qualifiedName}.${catalogColumn.name}`,
        };

        table.columns.push(column);
        if (!table.columnByNormalized.has(normalized)) {
          table.columnByNormalized.set(normalized, column);
        }
        this.allColumns.push(column);
        pushInto(this.columnsByName, catalogColumn.name, column);
        pushInto(this.columnsByNormalized, normalized, column);
      }

      this.tables.push(table);
      this.tableByQualified.set(qualifiedName.toLowerCase(), table);
      if (!this.tableByNormalized.has(table.normalized)) {
        this.tableByNormalized.set(table.normalized, table);
      }
    }
  }

  hasTable(name: string): boolean {
    return this.getTable(name) !== null;
  }

  hasColumn(name: string, tableHint?: string | null): boolean {
    return this.getColumn(name, tableHint) !== null;
  }

  getTable(name: string): IndexedTable | null {
    if (!name) {
      return null;
    }
    return (
      this.tableByQualified.get(name.toLowerCase()) ??
      this.tableByNormalized.get(normalizeIdentifier(name)) ??
      null
    );
  }

  getColumn(name: string, tableHint?: string | null): IndexedColumn | null {
    if (!name) {
      return null;
    }

    const scope = tableHint ? this.getTable(tableHint) : null;
    if (scope) {
      return scope.columnByNormalized.get(normalizeIdentifier(name)) ?? null;
    }

    const exact = this.columnsByName.get(name);
    if (exact && exact.length > 0) {
      return exact[0];
    }
    const normalized = this.columnsByNormalized.get(normalizeIdentifier(name));
    return normalized?.[0] ?? null;
  }

  resolveColumn(
    candidate: string,
    options: ResolveOptions = {},
  ): ColumnResolution | null {
    if (!candidate?.trim()) {
      return null;
    }

    const minScore = options.minScore ?? IDENTIFIER_THRESHOLDS.autoAccept;
    const maxAlternatives = options.maxAlternatives ?? DEFAULT_MAX_ALTERNATIVES;
    const scope = options.tableHint ? this.getTable(options.tableHint) : null;
    const pool = scope ? scope.columns : this.allColumns;

    const exactMatches =
      this.columnsByName.get(candidate) ??
      this.columnsByNormalized.get(normalizeIdentifier(candidate)) ??
      [];
    const scoped = scope
      ? exactMatches.filter((column) => column.table === scope)
      : exactMatches;

    if (scoped.length > 0) {
      const ranked = this.rankByTableAffinity(candidate, scoped);
      const [winner] = ranked;
      const isVerbatim = winner.name === candidate;
      return {
        candidate,
        column: winner,
        table: winner.table,
        score: isVerbatim ? 1 : EXACT_SCORE_FLOOR,
        exact: true,
        matchKind: isVerbatim ? "exact" : "normalized",
        // The name is already valid; several tables simply carry it. Callers
        // must not rewrite on this, but they may want to qualify it.
        ambiguous: ranked.length > 1,
        alternatives: ranked
          .slice(1, 1 + maxAlternatives)
          .map((column) => ({ column, score: EXACT_SCORE_FLOOR })),
      };
    }

    const match = bestMatch(candidate, pool, (column) => column.name, minScore);
    if (!match) {
      return null;
    }

    const alternatives = this.scoreAll(candidate, pool)
      .filter((entry) => entry.column !== match.item)
      .slice(0, maxAlternatives);

    return {
      candidate,
      column: match.item,
      table: match.item.table,
      score: match.score,
      exact: match.score >= EXACT_SCORE_FLOOR,
      matchKind: match.kind,
      ambiguous:
        match.score - match.runnerUpScore <= IDENTIFIER_THRESHOLDS.ambiguityMargin,
      alternatives,
    };
  }

  resolveTable(
    candidate: string,
    options: ResolveOptions = {},
  ): TableResolution | null {
    if (!candidate?.trim()) {
      return null;
    }

    const minScore = options.minScore ?? IDENTIFIER_THRESHOLDS.autoAccept;
    const maxAlternatives = options.maxAlternatives ?? DEFAULT_MAX_ALTERNATIVES;

    const direct = this.getTable(candidate);
    if (direct) {
      return {
        candidate,
        table: direct,
        score: direct.name === candidate ? 1 : EXACT_SCORE_FLOOR,
        exact: true,
        matchKind: direct.name === candidate ? "exact" : "normalized",
        ambiguous: false,
        alternatives: [],
      };
    }

    const match = bestMatch(candidate, this.tables, (table) => table.name, minScore);
    if (!match) {
      return null;
    }

    return {
      candidate,
      table: match.item,
      score: match.score,
      exact: match.score >= EXACT_SCORE_FLOOR,
      matchKind: match.kind,
      ambiguous:
        match.score - match.runnerUpScore <= IDENTIFIER_THRESHOLDS.ambiguityMargin,
      alternatives: this.tables
        .filter((table) => table !== match.item)
        .map((table) => ({
          table,
          score: identifierSimilarityDetail(candidate, table.name).score,
        }))
        .filter((entry) => entry.score >= IDENTIFIER_THRESHOLDS.suggestFloor)
        .sort((left, right) => right.score - left.score)
        .slice(0, maxAlternatives),
    };
  }

  suggestColumns(candidate: string, limit = DEFAULT_MAX_ALTERNATIVES) {
    return this.scoreAll(candidate, this.allColumns)
      .slice(0, limit)
      .map((entry) => ({
        qualifiedName: entry.column.qualifiedName,
        score: entry.score,
      }));
  }

  suggestTables(candidate: string, limit = DEFAULT_MAX_ALTERNATIVES) {
    return this.tables
      .map((table) => ({
        qualifiedName: table.qualifiedName,
        score: identifierSimilarityDetail(candidate, table.name).score,
      }))
      .filter((entry) => entry.score >= IDENTIFIER_THRESHOLDS.suggestFloor)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }

  private scoreAll(candidate: string, pool: readonly IndexedColumn[]) {
    return pool
      .map((column) => ({
        column,
        score: identifierSimilarityDetail(candidate, column.name).score,
      }))
      .filter((entry) => entry.score >= IDENTIFIER_THRESHOLDS.suggestFloor)
      .sort((left, right) => right.score - left.score);
  }

  /**
   * Orders columns that share a name across tables. A candidate like
   * `customer_id` should land on the `customers` table before some unrelated
   * one; after that, prefer keys, then larger tables, then a stable name order.
   */
  private rankByTableAffinity(
    candidate: string,
    columns: IndexedColumn[],
  ): IndexedColumn[] {
    if (columns.length < 2) {
      return columns;
    }

    const candidateTokens = new Set(identifierTokens(candidate));
    const affinity = (column: IndexedColumn) =>
      column.table.tokens.filter((token) => candidateTokens.has(token)).length;

    return [...columns].sort((left, right) => {
      const byAffinity = affinity(right) - affinity(left);
      if (byAffinity !== 0) {
        return byAffinity;
      }
      if (left.isPrimaryKey !== right.isPrimaryKey) {
        return left.isPrimaryKey ? -1 : 1;
      }
      const byRows = (right.table.rowCount ?? 0) - (left.table.rowCount ?? 0);
      if (byRows !== 0) {
        return byRows;
      }
      return left.qualifiedName.localeCompare(right.qualifiedName);
    });
  }
}

function pushInto<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key);
  if (existing) {
    existing.push(value);
    return;
  }
  map.set(key, [value]);
}

export function buildSchemaIndex(
  knowledge: DatabaseKnowledgeRuntime,
  fingerprint?: string | null,
): SchemaIndex {
  return new SchemaIndexImpl(
    knowledge,
    computeSchemaIdentity(knowledge, fingerprint),
  );
}

// Same delete-and-reinsert LRU shape as the plan cache. A handful of entries is
// plenty: a single process serves few distinct schemas at a time, and rebuilding
// is cheap enough that a miss is not worth worrying about.
const INDEX_CACHE_MAX = 4;
const indexCache = new Map<string, SchemaIndex>();

export function getSchemaIndex(
  knowledge: DatabaseKnowledgeRuntime,
  fingerprint?: string | null,
): SchemaIndex {
  const identity = computeSchemaIdentity(knowledge, fingerprint);

  const cached = indexCache.get(identity);
  if (cached) {
    indexCache.delete(identity);
    indexCache.set(identity, cached);
    return cached;
  }

  const index = buildSchemaIndex(knowledge, identity);
  indexCache.set(identity, index);

  while (indexCache.size > INDEX_CACHE_MAX) {
    const oldest = indexCache.keys().next();
    if (oldest.done) {
      break;
    }
    indexCache.delete(oldest.value);
  }

  return index;
}

/** Exposed for tests. */
export function clearSchemaIndexCache(): void {
  indexCache.clear();
}
