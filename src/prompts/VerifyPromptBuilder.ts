import type { DatabaseKnowledgeRuntime } from "../types.js";

const SAMPLE_ROWS = 10;

/**
 * A second look at an executed query before its result is shown.
 *
 * A query that runs is not necessarily right: a filter on the wrong column or
 * the wrong time range executes cleanly and returns plausible numbers. The
 * checker sees the schema, the SQL and the first rows, and flags only clear
 * mistakes; anything uncertain passes, because a false alarm costs a needless
 * rewrite of a correct query.
 */
export class VerifyPromptBuilder {
  build(input: {
    knowledge: DatabaseKnowledgeRuntime;
    question: string;
    sql: string;
    columns: string[];
    rows: Array<Record<string, unknown>>;
    rowCount: number;
  }): { systemPrompt: string; userPrompt: string } {
    const catalog = input.knowledge.tables
      .map((table) => {
        const name = table.schemaName ? `${table.schemaName}.${table.name}` : table.name;
        const relations = table.foreignKeys.map((fk) => `${fk.sourceColumn} -> ${fk.targetTable}.${fk.targetColumn}`);
        return `${name}(${table.columns.map((column) => column.name).join(", ")})${relations.length ? ` relations: ${relations.join("; ")}` : ""}`;
      })
      .join("\n");

    return {
      systemPrompt: [
        "You check whether a SQL query and its result correctly answer a user's question about a database.",
        'Return JSON {"answersQuestion": boolean, "problem": string}.',
        "Set answersQuestion to false only for a clear mistake: the wrong table or column, a missing or wrong filter, the wrong time range, the wrong grouping or aggregation, or a result that cannot contain the answer. Describe the mistake in one sentence in problem.",
        "Do not flag column names, extra columns, row order, rounding, or formatting. If you are unsure, set answersQuestion to true and leave problem empty.",
        "Schema:",
        catalog,
      ].join("\n"),
      userPrompt: [
        `Question: ${input.question}`,
        `SQL:\n${input.sql}`,
        `Columns: ${input.columns.join(", ")}`,
        `Total rows: ${input.rowCount}`,
        `First rows: ${JSON.stringify(input.rows.slice(0, SAMPLE_ROWS))}`,
      ].join("\n"),
    };
  }
}
