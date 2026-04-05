export const SMALL_TALK_PATTERNS = [
  /^(hi|hello|hey|yo|sup|good morning|good afternoon|good evening)\b/i,
  /\bhow are you\b/i,
  /\bwho are you\b/i,
  /\bwhat can you do\b/i,
  /\bhelp me\b/i,
  /\bthank(s| you)\b/i,
];

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

export const SHORT_VISUALIZATION_PATTERNS = [
  /\bvisuali[sz]e\b/i,
  /\bchart\b/i,
  /\bgraph\b/i,
  /\bplot\b/i,
];

export const RANKING_METRIC_HINTS = [
  /\b(sales|revenue|orders?|count|total|amount|profit|score|value|visits?|clicks?|purchases?|downloads?|views?)\b/i,
];
