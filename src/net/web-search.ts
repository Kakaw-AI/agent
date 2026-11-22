/**
 * Web search through our Firecrawl server (self-hosted, v2 API).
 *
 * Configured by FIRECRAWL_API_URL and FIRECRAWL_API_KEY. Without them the
 * agent never offers web search, so a deploy without the keys behaves as before.
 */

export type WebSource = { title: string; url: string; content: string };

const RESULTS = 3;
/** Page text kept per result: enough for the facts, small enough for the prompt. */
const MAX_CONTENT_CHARS = 4000;
const TIMEOUT_MS = 20_000;

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
    .slice(0, RESULTS)
    .map((item) => ({
      title: item.title?.trim() || item.url!,
      url: item.url!,
      content: (item.markdown?.trim() || item.description?.trim() || "").slice(0, MAX_CONTENT_CHARS),
    }));
}
