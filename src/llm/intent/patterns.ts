// Whole-message matches only. The previous patterns matched a greeting or
// "help me" at the start of any message, so "hi, how many orders last month?"
// and "help me find the top customers" got a canned greeting instead of an
// answer. Anything that might carry a question goes to the data path.
const SMALL_TALK_PATTERNS = [
  /^(hi|hello|hey|hiya|yo|sup|good (morning|afternoon|evening))( there)?[\s!.,?]*$/i,
  /^(thanks|thank you|thx|ty|cheers)( (so|very) much)?[\s!.,]*$/i,
  /^(how are you|who are you|what can you do|what do you do)[\s!.,?]*$/i,
];

export function isSmallTalk(message: string): boolean {
  const text = message.trim();
  return SMALL_TALK_PATTERNS.some((pattern) => pattern.test(text));
}

export const VISUALIZATION_PATTERNS = [
  /\bvisuali[sz]e\b/i,
  /\bchart\b/i,
  /\bgraph\b/i,
  /\bplot\b/i,
  /\bdashboard\b/i,
  /\bcompare visually\b/i,
];

export const ANALYTICAL_HINT_PATTERNS = [
  /\b(by|per|across|vs|versus|compare|comparison|trend|top|bottom|count|total|sum|average|avg|most|least|highest|lowest|which|what|who|over time|through time|across time)\b/i,
];

export const RANKING_METRIC_HINTS = [
  /\b(sales|revenue|orders?|count|total|amount|profit|score|value|visits?|clicks?|purchases?|downloads?|views?)\b/i,
];
