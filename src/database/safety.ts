export function assertReadOnlySql(sql: string) {
  const trimmed = sql.trim().replace(/;+$/, "");
  const upper = trimmed.toUpperCase();

  if (!trimmed) {
    throw new Error("Generated SQL was empty.");
  }

  if (trimmed.includes(";")) {
    throw new Error("Only a single read-only SQL statement is allowed.");
  }

  const allowedPrefix = ["SELECT", "WITH", "EXPLAIN", "PRAGMA"].some(
    (keyword) => upper.startsWith(keyword),
  );
  if (!allowedPrefix) {
    throw new Error("Only read-only SQL is allowed.");
  }

  const blocked = [
    "INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE",
    "TRUNCATE", "GRANT", "REVOKE", "ATTACH", "DETACH", "VACUUM",
  ];
  if (blocked.some((keyword) => upper.includes(keyword))) {
    throw new Error("Unsafe SQL was blocked before execution.");
  }
}
