import { BaseSqlPromptBuilder } from "../SqlPromptBuilder.js";

/**
 * MongoDB sources are queried in SQL that NoQL (@synatic/noql) translates to
 * an aggregation pipeline. The rules below keep the model inside the subset
 * NoQL parses; anything outside it comes back as an error and is repaired.
 */
export class MongoSqlPromptBuilder extends BaseSqlPromptBuilder {
  protected buildDialectInstructions(): string[] {
    return [
      "You generate SQL for analytics over a MongoDB database. The SQL is translated to a MongoDB aggregation pipeline by NoQL, so write only what NoQL supports.",
      "Use one read-only SELECT statement only. Never produce INSERT, UPDATE, DELETE or other write/admin commands.",
      "Each catalog table is a collection. Reference it by its plain name, with no schema prefix.",
      "Fields of nested documents appear in the catalog as dot paths such as address.city. Always wrap a dot path in backticks: `address.city`. Never write it unquoted, or it is read as a table alias.",
      "Field names and string values are case-sensitive.",
      "Alias every function, aggregate and subquery: SUM(total) AS total_revenue, (SELECT ...) AS t.",
      "WHERE cannot use a SELECT alias; repeat the expression instead.",
      "IN (SELECT ...) is not supported. Use a JOIN instead.",
      "A JOIN yields an array per row unless the joined table carries a hint: write JOIN orders AS `o|unwind` ON o.customer_id = c._id to get one row per match, or `o|first` for a single match.",
      "Use CONCAT(a, b) to join strings; + does not concatenate.",
      "Array fields need UNWIND before their elements can be filtered or grouped.",
      "_id values are ObjectIds. Compare them to other _id or reference fields, not to string literals.",
      "Prefer exact field names from the provided catalog.",
      "When you return computed columns, always alias them with short user-facing names such as total_revenue or order_count.",
    ];
  }
}
