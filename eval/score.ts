/**
 * Execution-accuracy scoring: the agent's result set must contain the correct
 * one. Column names, column order and row order are ignored, and the agent may
 * return extra columns (an id next to a name is not wrong). Numbers compare
 * within half a cent, so `SUM(x)` and `ROUND(SUM(x), 2)` agree; rounding both
 * sides to two places instead would split 10.005 and 10.0049.
 */

type Row = Record<string, unknown>;
type Value = number | string | null;

const TOLERANCE = 0.006;

function normalize(value: unknown): Value {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  const text = String(value).trim();
  if (text !== "" && Number.isFinite(Number(text))) return Number(text);
  return text.toLowerCase();
}

function compare(a: Value, b: Value): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return a < b ? -1 : 1;
}

function equal(a: Value, b: Value): boolean {
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) <= Math.max(TOLERANCE, Math.abs(a) * 1e-9);
  }
  return a === b;
}

function compareTuples(a: Value[], b: Value[]): number {
  for (let index = 0; index < a.length; index += 1) {
    const order = compare(a[index], b[index]);
    if (order !== 0) return order;
  }
  return 0;
}

/** Sorted pairwise comparison; sound while the tolerance is far below the gaps between values. */
function sameMultiset(left: Value[][], right: Value[][]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort(compareTuples);
  const b = [...right].sort(compareTuples);
  return a.every((tuple, row) => tuple.every((value, index) => equal(value, b[row][index])));
}

function project(rows: Row[], columns: string[]): Value[][] {
  return rows.map((row) => columns.map((name) => normalize(row[name])));
}

export function resultsMatch(
  gold: { columns: string[]; rows: Row[] },
  agent: { columns: string[]; rows: Row[] },
): boolean {
  if (gold.rows.length !== agent.rows.length) return false;
  if (gold.rows.length === 0) return true;

  // Candidate agent columns for each gold column: same values, any order.
  const candidates = gold.columns.map((goldColumn) => {
    const values = project(gold.rows, [goldColumn]);
    return agent.columns.filter((agentColumn) => sameMultiset(values, project(agent.rows, [agentColumn])));
  });
  if (candidates.some((list) => list.length === 0)) return false;

  // Columns can agree individually and still come from different rows, so
  // confirm whole rows match under some assignment of gold to agent columns.
  const goldTuples = project(gold.rows, gold.columns);
  const assign = (index: number, used: string[]): boolean => {
    if (index === gold.columns.length) return sameMultiset(goldTuples, project(agent.rows, used));
    return candidates[index].some((name) => !used.includes(name) && assign(index + 1, [...used, name]));
  };
  return assign(0, []);
}
