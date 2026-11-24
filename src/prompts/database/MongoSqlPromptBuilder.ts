import { BaseSqlPromptBuilder } from "../SqlPromptBuilder.js";

/**
 * MongoDB sources are queried with native aggregation pipelines, written as
 * Extended JSON in the draft's `sql` field (see parseMongoQuery in mongo.ts).
 */
export class MongoSqlPromptBuilder extends BaseSqlPromptBuilder {
  protected buildDialectInstructions(): string[] {
    return [
      "You write MongoDB aggregation queries for analytics over a MongoDB database. Wherever these instructions say SQL or query, they mean this aggregation query.",
      'Put the query in the sql field as one JSON object: {"collection": "<collection>", "pipeline": [<stages>]}. Strict JSON: double quotes, no comments, no trailing commas, no JavaScript. Write typed values in Extended JSON: {"$oid": "..."} for an ObjectId, {"$date": "2025-01-01T00:00:00Z"} for a date.',
      "Read only: never use $out or $merge, and never $where, $function or $accumulator.",
      "Each catalog table is a collection. Fields of nested documents appear in the catalog as dot paths such as address.city; use them as written: \"address.city\" as a $match key, \"$address.city\" in an expression.",
      'Field names and string values are case-sensitive. For a partial or case-insensitive text match use {"$regex": "term", "$options": "i"}.',
      "Join with $lookup (from, localField, foreignField, as), then $unwind the joined array for one row per match. Reference fields usually hold ObjectIds and compare to _id directly; when the two sides differ in type (an ObjectId and its string form), use a $lookup with let and a pipeline that converts one side with $toObjectId or $toString.",
      "Filter early: $match on a collection's own fields before any $lookup, and start from the collection the filter narrows most, so the join runs on few documents. A $lookup over every document of a large collection is cancelled after 30 seconds.",
      "End with $project: name each returned field with a short user-facing name such as total_revenue or order_count, return one value per field, and leave _id out (\"_id\": 0) unless it is wanted.",
      "$group needs an _id; project the group key back out under a readable name. Count with {\"$sum\": 1}. To collect a list per group use $push or $addToSet.",
      "Arrays need $unwind before their elements can be filtered or grouped.",
      "Results stop at 200 rows. For top-N questions add your own $sort and $limit.",
      'Example: {"collection": "orders", "pipeline": [{"$match": {"status": "Shipped"}}, {"$group": {"_id": "$customer_id", "order_count": {"$sum": 1}}}, {"$sort": {"order_count": -1}}, {"$limit": 5}, {"$project": {"_id": 0, "customer_id": "$_id", "order_count": 1}}]}',
      "Prefer exact field names from the provided catalog.",
    ];
  }
}
