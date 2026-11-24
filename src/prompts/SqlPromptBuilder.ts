import { renderCatalogLine } from "../database/catalog-render.js";
import type { DatabaseCatalogTable, DatabaseKnowledgeRuntime } from "../types.js";
import { getRequiredVisualizationFields } from "../graph/visualization.js";
import type { SqlPromptBuildInput, SqlPromptOptions } from "../graph/types.js";
import { webSearchConfigured } from "../net/web-search.js";
import { WEB_QUERY_RULES, WEB_WHERE_TO_LOOK } from "../agent/web.js";

const OUTPUT_INSTRUCTIONS = [
  "Return JSON with these fields: needsClarification (boolean), clarifyingQuestion (string), options (list of strings), sql (string), rationale (string), needsWeb (boolean), webQuery (string).",
  "Ask for clarification only when the question cannot be answered without a choice the user has to make, and neither the conversation nor the catalog settles it. Example: 'who are our best customers?' when best could mean most spent, most orders or most recent. Then set needsClarification to true, write one short clarifyingQuestion, give 2 to 4 short options phrased as complete questions the user could send, and leave sql empty.",
  "Otherwise set needsClarification to false, leave clarifyingQuestion empty and options empty, and write the SQL. Prefer answering: when one reading is clearly the usual one, use it and state the assumption in the rationale.",
];

// Decided once per process, so the system prompt stays byte-identical and cacheable.
function webInstructions(): string[] {
  if (!webSearchConfigured()) {
    return ["Always set needsWeb to false and webQuery empty."];
  }
  return [
    "WEB SEARCH: set needsWeb to true when answering needs facts that are not in this database or are newer than it: anything the user asks about 'online', 'on the internet', 'latest' or 'current' beyond what the database stores, public facts about a person, company or product, industry benchmarks, market prices, exchange rates, public statistics, definitions, news. Then write webQuery: a short search query.",
    WEB_QUERY_RULES,
    WEB_WHERE_TO_LOOK,
    "If the question needs both the database and the web (e.g. comparing our churn to the industry average), write the SQL AND set needsWeb with webQuery. If it needs only the web, leave sql empty. If the database alone answers it, set needsWeb to false and leave webQuery empty.",
  ];
}

export abstract class BaseSqlPromptBuilder {
  protected abstract buildDialectInstructions(): string[];

  protected buildVisualizationModeInstruction(options: SqlPromptOptions): string {
    if (options.wantsVisualization) {
      return "The user explicitly wants a visualization. Prefer a result set that is easy to chart, with one category/time column and one numeric metric when possible.";
    }
    return "Only prepare chart-friendly result sets when the question clearly calls for it.";
  }

  protected buildVisualizationFieldsInstruction(options: SqlPromptOptions): string {
    if (!options.visualizationRequest) {
      return "No normalized visualization request was provided.";
    }
    const fields = getRequiredVisualizationFields(options.visualizationRequest).join(", ");
    return `The normalized visualization request requires these result fields to be preserved exactly: ${fields}.`;
  }

  protected buildVisualizationDimensionInstruction(options: SqlPromptOptions): string {
    if (!options.visualizationRequest) {
      return "When no visualization request is provided, keep the result set aligned to the analytical question.";
    }
    return "Do not drop requested visualization dimensions. If the request cannot be satisfied exactly, say so in the rationale and keep all requested fields in the SQL draft.";
  }

  protected buildMetricInstruction(options: SqlPromptOptions): string {
    if (options.needsImplicitCountMetric) {
      return "If the user asks to visualize a category without naming a metric, group by that category and use COUNT(*) as the metric.";
    }
    return "Do not invent unsupported metrics.";
  }

  protected buildSchemaLine(table: DatabaseCatalogTable): string {
    // Shared with the sync-time size estimate so the two cannot drift.
    return renderCatalogLine(table);
  }

  protected buildInitialPrompt(
    knowledge: DatabaseKnowledgeRuntime,
    options: SqlPromptOptions,
  ): string {
    const schemaLines = knowledge.tables.map((table) => this.buildSchemaLine(table));

    // Everything up to the catalog is the same for every question on this
    // database, so providers can serve it from their prompt cache. The
    // per-question visualization lines go last; before the catalog they broke
    // the shared prefix whenever one question wanted a chart and the next did not.
    return [
      ...this.buildDialectInstructions(),
      "Every aggregate metric must have a readable user-facing alias such as model_count, total_revenue, or average_rating.",
      "Return each thing the question is about once. A table holding several values per row of another (URLs, tags, aliases, line items) multiplies rows when joined, so join at most one such list per query level. When the question needs several lists, aggregate each in its own subquery into one value per row (for example string_agg in PostgreSQL, group_concat in SQLite). Do not repeat an entity's columns on every row of one of its lists unless the question asks for them.",
      "When you filter on a text column, use a value exactly as it appears in the catalog examples (same spelling and case). If the example values do not include the one you need, match case-insensitively.",
      "A column shown with 'values:' lists every value it holds. When the question names one of them (a category, status or name), filter on that exact value; do not ask which one the user means and do not substitute a shorter or similar value.",
      "Earlier turns of the conversation include the SQL they ran. For a follow-up, start from that SQL and change only what the new question changes.",
      ...OUTPUT_INSTRUCTIONS,
      ...webInstructions(),
      `Knowledge summary: ${knowledge.summary || "No summary available."}`,
      "Catalog:",
      ...schemaLines,
      "For this question:",
      this.buildVisualizationModeInstruction(options),
      this.buildVisualizationFieldsInstruction(options),
      this.buildVisualizationDimensionInstruction(options),
      this.buildMetricInstruction(options),
    ].join("\n");
  }

  /**
   * Repair variant of the system prompt.
   *
   * Deliberately free of the failing SQL and the error text. Anthropic prompt
   * caching marks the whole system string as one cacheable block, so appending
   * per-attempt detail here changed the block on every retry and re-charged the
   * full schema catalog each time. The volatile detail now travels in the user
   * message; this differs from the initial prompt only by one fixed sentence.
   */
  protected buildRepairPrompt(
    knowledge: DatabaseKnowledgeRuntime,
    options: SqlPromptOptions,
  ): string {
    return [
      this.buildInitialPrompt(knowledge, options),
      "The prior SQL was wrong. Write a corrected query. The failing SQL and what was wrong with it appear in the user message. Do not ask for clarification now: set needsClarification to false and return SQL.",
    ].join("\n");
  }

  build({ knowledge, options = {}, repair }: SqlPromptBuildInput): string {
    if (repair) {
      return this.buildRepairPrompt(knowledge, options);
    }
    return this.buildInitialPrompt(knowledge, options);
  }
}
