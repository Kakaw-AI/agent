import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLException } from "../exceptions/SQLException.js";
import type { AgentDatabaseRuntime } from "../types.js";

const CACHE_DIR = join(tmpdir(), "kakaw-sqlite");

// Each upload lives at a unique, immutable R2 object key, so the key alone is a
// safe cache identity — a new upload produces a new key and therefore a new
// cache file.
function cacheFilePath(objectKey: string): string {
  const safe = Buffer.from(objectKey).toString("hex");
  return join(CACHE_DIR, `${safe}.sqlite`);
}

async function isNonEmptyFile(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

/**
 * Returns a local path to the SQLite file for the given runtime, downloading it
 * from the presigned GET URL on a cache miss. The file is cached under the OS
 * temp dir keyed by R2 object key so repeated chat queries don't re-download it.
 */
export async function materializeSqlite(
  database: AgentDatabaseRuntime,
): Promise<string> {
  if (!database.sqliteObjectKey) {
    throw new SQLException("SQLite runtime is missing sqliteObjectKey.");
  }

  const target = cacheFilePath(database.sqliteObjectKey);
  if (await isNonEmptyFile(target)) {
    return target;
  }

  if (!database.sqliteDownloadUrl) {
    throw new SQLException("SQLite runtime is missing sqliteDownloadUrl.");
  }

  await mkdir(CACHE_DIR, { recursive: true });

  const response = await fetch(database.sqliteDownloadUrl);
  if (!response.ok) {
    throw new SQLException(
      `Failed to download SQLite file from storage (status ${response.status}).`,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  // Write to a temp path then atomically rename to avoid serving a partial file
  // to a concurrent request.
  const tempPath = `${target}.${process.pid}.${Date.now()}.part`;
  await writeFile(tempPath, buffer);
  await rename(tempPath, target);

  return target;
}
