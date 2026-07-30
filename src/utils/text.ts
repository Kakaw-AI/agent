export function normalizeQuestion(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function toReadableLabel(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function dedupeFieldNames(fields: Array<string | null | undefined>) {
  const normalizedFields: string[] = [];

  for (const field of fields) {
    if (typeof field !== "string") {
      continue;
    }

    const normalized = field.trim();
    if (!normalized || normalizedFields.includes(normalized)) {
      continue;
    }

    normalizedFields.push(normalized);
  }

  return normalizedFields;
}

/**
 * Flattens LangChain message content, preserving whitespace exactly.
 *
 * Streaming callers must use this rather than `flattenContent`: trimming each
 * chunk deletes the spaces that separate words, so "You have " + "three " turns
 * into "You havethree".
 */
export function flattenContentRaw(content: unknown) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && "text" in part
          ? String(part.text ?? "")
          : "",
      )
      .join("");
  }

  return "";
}

export function flattenContent(content: unknown) {
  return flattenContentRaw(content).trim();
}