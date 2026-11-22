/**
 * Web search through our Firecrawl server (self-hosted, v2 API).
 *
 * Configured by FIRECRAWL_API_URL and FIRECRAWL_API_KEY. Without them the
 * agent never offers web search, so a deploy without the keys behaves as before.
 */

export type WebSource = { title: string; url: string; content: string };

/** Results asked for per search; unusable pages are dropped from these. */
const RESULTS = 8;
/** Usable pages kept per search. */
const KEEP = 4;
/** Shorter page text is a stub, a login wall or an error page. */
const MIN_CONTENT_CHARS = 300;
/** Page text kept per result: enough for the facts, small enough for the prompt. */
const MAX_CONTENT_CHARS = 4000;
// Firecrawl gives up on slow pages at SEARCH_TIMEOUT_MS; ours only guards a hung server.
const SEARCH_TIMEOUT_MS = 25_000;
const TIMEOUT_MS = 40_000;

export function webSearchConfigured(): boolean {
  return Boolean(process.env.FIRECRAWL_API_URL?.trim() && process.env.FIRECRAWL_API_KEY?.trim());
}

export async function searchWeb(query: string, signal?: AbortSignal): Promise<WebSource[]> {
  const base = process.env.FIRECRAWL_API_URL!.trim().replace(/\/+$/, "");
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const response = await fetch(`${base}/v2/search`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.FIRECRAWL_API_KEY!.trim()}`,
      "content-type": "application/json",
      // Cloudflare in front of the server rejects clients without a user agent.
      "user-agent": "kakaw-agent/1.0",
    },
    body: JSON.stringify({
      query,
      limit: RESULTS,
      timeout: SEARCH_TIMEOUT_MS,
      scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
    }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) {
    throw new Error(`Web search failed with HTTP ${response.status}.`);
  }

  const payload = (await response.json()) as {
    data?: { web?: Array<{ url?: string; title?: string; description?: string; markdown?: string }> };
  };
  return (payload.data?.web ?? [])
    .filter((item) => typeof item.url === "string" && /^https?:\/\//.test(item.url))
    .map((item) => ({
      title: item.title?.trim() || item.url!,
      url: item.url!,
      content: (item.markdown?.trim() || item.description?.trim() || "").slice(0, MAX_CONTENT_CHARS),
    }))
    .filter((source) => isUsablePage(source.content))
    .slice(0, KEEP);
}

// Pages that are only a gate in front of the content.
const GATE_PATTERNS = [
  /before you continue to/i,
  /we use cookies/i,
  /accept (all )?cookies/i,
  /consent\.(youtube|google)\.com/i,
  /log ?in to (see|continue|view)/i,
  /sign ?in to (see|continue|view)/i,
  /enable javascript/i,
  /verify (that )?you are (a )?human/i,
  /access denied/i,
];

/** False for stubs, cookie and consent walls, login walls and bot checks. */
export function isUsablePage(content: string): boolean {
  const text = content.trim();
  if (text.length < MIN_CONTENT_CHARS) return false;
  // A long article may mention cookies in its footer; only a short page that
  // is mostly the gate is dropped.
  return !(text.length < 2000 && GATE_PATTERNS.some((pattern) => pattern.test(text)));
}
