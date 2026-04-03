import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadAgentEnv(cwd = process.cwd()) {
  const candidates = [
    { path: resolve(cwd, ".env") },
    {
      path: resolve(cwd, "../back/.env"),
      allowedKeys: new Set(["AGENT_SHARED_SECRET"]),
    },
  ];

  for (const candidate of candidates) {
    loadEnvFile(candidate.path, candidate.allowedKeys);
  }
}

function loadEnvFile(path: string, allowedKeys?: Set<string>) {
  if (!existsSync(path)) {
    return;
  }

  const content = readFileSync(path, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    if (
      !key ||
      (allowedKeys && !allowedKeys.has(key)) ||
      process.env[key] !== undefined
    ) {
      continue;
    }

    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    process.env[key] = stripWrappingQuotes(rawValue);
  }
}

function stripWrappingQuotes(value: string) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
