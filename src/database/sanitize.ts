const SECRET_FIELD_PATTERN = /(password|secret|token|key|credential|auth|session)/i;

export function collectSampleValues(rows: Array<Record<string, unknown>>, columnName: string) {
  return rows
    .map((row) => row[columnName])
    .filter((value) => value !== undefined)
    .slice(0, 3);
}

export function normalizeName(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w]+/g, "_")
    .replace(/__+/g, "_")
    .replace(/^_|_$/g, "");
}

export function sanitizeRow(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, sanitizeValue(key, value)]),
  );
}

function sanitizeValue(key: string, value: unknown): unknown {
  if (SECRET_FIELD_PATTERN.test(key)) {
    return "[redacted]";
  }
  if (Buffer.isBuffer(value)) {
    return `[binary:${value.length}]`;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.slice(0, 10).map((entry) => sanitizeValue(key, entry));
  }
  if (value && typeof value === "object") {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return String(value);
    }
  }
  if (typeof value === "string" && value.length > 300) {
    return `${value.slice(0, 297)}...`;
  }
  return value;
}
export function normalizeColumnName(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, "_");
}

export function findColumnByName(columns: string[], candidate: string | null | undefined) {
  if (!candidate) {
    return null;
  }

  const normalizedCandidate = normalizeColumnName(candidate);
  return (
    columns.find((column) => normalizeColumnName(column) === normalizedCandidate) ?? null
  );
}
export function extractPostgresIndexColumns(indexDefinition: string) {
  const match = indexDefinition.match(/\((.+)\)/);
  if (!match) {
    return [];
  }

  return match[1]
    .split(",")
    .map((part) => part.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}
