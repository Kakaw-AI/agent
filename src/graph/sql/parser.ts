// agent-ts/src/graph/sql/parser.ts

export function normalizeSqlIdentifier(value: string) {
  return value.trim().replace(/^["'`]+|["'`]+$/g, "").toLowerCase().replace(/\s+/g, "_");
}

export function splitSqlSelectList(selectClause: string) {
  const items: string[] = [];
  let current = "";
  let depth = 0;

  for (const char of selectClause) {
    if (char === "(") {
      depth += 1;
    } else if (char === ")" && depth > 0) {
      depth -= 1;
    }

    if (char === "," && depth === 0) {
      if (current.trim()) {
        items.push(current.trim());
      }
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    items.push(current.trim());
  }

  return items;
}

export function isIdentifierBoundary(char: string | undefined) {
  return !char || !/[a-z0-9_]/i.test(char);
}

export function findKeywordAtTopLevel(sql: string, keyword: string, startIndex = 0) {
  const normalizedKeyword = keyword.toLowerCase();
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktickQuote = false;

  for (let index = startIndex; index <= sql.length - normalizedKeyword.length; index += 1) {
    const char = sql[index];
    const lowerChar = char.toLowerCase();

    if (!inDoubleQuote && !inBacktickQuote && char === "'" && sql[index - 1] !== "\\") {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (!inSingleQuote && !inBacktickQuote && char === '"' && sql[index - 1] !== "\\") {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && char === "`" && sql[index - 1] !== "\\") {
      inBacktickQuote = !inBacktickQuote;
      continue;
    }

    if (inSingleQuote || inDoubleQuote || inBacktickQuote) {
      continue;
    }

    if (char === "(") {
      depth += 1;
      continue;
    }

    if (char === ")" && depth > 0) {
      depth -= 1;
      continue;
    }

    if (depth !== 0) {
      continue;
    }

    if (
      lowerChar === normalizedKeyword[0] &&
      sql.slice(index, index + normalizedKeyword.length).toLowerCase() === normalizedKeyword &&
      isIdentifierBoundary(sql[index - 1]) &&
      isIdentifierBoundary(sql[index + normalizedKeyword.length])
    ) {
      return index;
    }
  }

  return -1;
}

export function extractFinalSelectClause(sql: string) {
  let searchIndex = 0;
  let lastTopLevelSelect = -1;

  while (searchIndex < sql.length) {
    const nextSelect = findKeywordAtTopLevel(sql, "select", searchIndex);
    if (nextSelect === -1) {
      break;
    }

    lastTopLevelSelect = nextSelect;
    searchIndex = nextSelect + "select".length;
  }

  if (lastTopLevelSelect === -1) {
    return null;
  }

  const fromIndex = findKeywordAtTopLevel(sql, "from", lastTopLevelSelect + "select".length);
  if (fromIndex === -1) {
    return null;
  }

  return sql.slice(lastTopLevelSelect + "select".length, fromIndex);
}

export function inferSqlSelectAlias(selectItem: string) {
  const asMatch = selectItem.match(/\bas\s+("?[\w ]+"?)\s*$/i);
  if (asMatch?.[1]) {
    return asMatch[1].trim();
  }

  const computedAliasMatch = selectItem.match(/.+\s+("?[\w ]+"?)\s*$/);
  if (computedAliasMatch?.[1] && /[()]/.test(selectItem)) {
    return computedAliasMatch[1].trim();
  }

  const bareColumnMatch = selectItem.match(/(?:^|\.)(["`]?[\w ]+["`]?)\s*$/);
  if (bareColumnMatch?.[1] && !/[()]/.test(selectItem)) {
    return bareColumnMatch[1].trim();
  }

  return null;
}
