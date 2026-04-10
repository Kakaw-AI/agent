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

export function flattenContent(content: unknown) {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && "text" in part
          ? String(part.text ?? "")
          : "",
      )
      .join("")
      .trim();
  }

  return "";
}