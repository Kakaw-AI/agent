/**
 * Web search through our Firecrawl server (self-hosted, v2 API).
 *
 * Configured by FIRECRAWL_API_URL and FIRECRAWL_API_KEY. Without them the
 * agent never offers web search, so a deploy without the keys behaves as before.
 */

export type WebSource = { title: string; url: string; content: string };

/** Results asked for per search. */
const RESULTS = 8;
/** Pages scraped per search, in result order; the rest keep their snippet. */
const SCRAPE = 6;
/** Sources kept per search. */
const KEEP = 4;
/** Shorter page text is a stub, a login wall or an error page. */
const MIN_CONTENT_CHARS = 300;
/** A search snippet shorter than this says nothing on its own. */
const MIN_SNIPPET_CHARS = 40;
/** Page text kept per result: enough for the facts, small enough for the prompt. */
const MAX_CONTENT_CHARS = 4000;
const SEARCH_TIMEOUT_MS = 20_000;
// Firecrawl gives up on a slow page at PAGE_TIMEOUT_MS; ours only guards a hung server.
const PAGE_TIMEOUT_MS = 15_000;
const PAGE_FETCH_TIMEOUT_MS = 25_000;

export function webSearchConfigured(): boolean {
  return Boolean(process.env.FIRECRAWL_API_URL?.trim() && process.env.FIRECRAWL_API_KEY?.trim());
}

async function firecrawl<T>(path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const base = process.env.FIRECRAWL_API_URL!.trim().replace(/\/+$/, "");
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.FIRECRAWL_API_KEY!.trim()}`,
      "content-type": "application/json",
      // Cloudflare in front of the server rejects clients without a user agent.
      "user-agent": "kakaw-agent/1.0",
    },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) {
    throw new Error(`Firecrawl ${path} failed with HTTP ${response.status}.`);
  }
  return (await response.json()) as T;
}

/**
 * Searches, then reads the top pages one request each.
 *
 * Asking the search endpoint to scrape as well returned no results at all
 * whenever one page was slow, so the two are split: the search alone is fast
 * and reliable, and a page that fails only falls back to its own snippet.
 */
export async function searchWeb(query: string, signal?: AbortSignal): Promise<WebSource[]> {
  const payload = await firecrawl<{ data?: { web?: Array<{ url?: string; title?: string; description?: string }> } }>(
    "/v2/search",
    { query, limit: RESULTS },
    SEARCH_TIMEOUT_MS,
    signal,
  );
  const results = (payload.data?.web ?? []).filter((item) => typeof item.url === "string" && /^https?:\/\//.test(item.url));

  const pages = await Promise.allSettled(
    results.slice(0, SCRAPE).map((item) =>
      firecrawl<{ data?: { markdown?: string } }>(
        "/v2/scrape",
        { url: item.url, formats: ["markdown"], onlyMainContent: true, timeout: PAGE_TIMEOUT_MS },
        PAGE_FETCH_TIMEOUT_MS,
        signal,
      ),
    ),
  );
  if (signal?.aborted) throw signal.reason;

  const terms = searchTerms(query);
  return results
    .flatMap((item, index) => {
      const title = item.title?.trim() || item.url!;
      const scraped = pages[index];
      const page = cleanPage(scraped?.status === "fulfilled" ? (scraped.value.data?.markdown ?? "") : "");
      if (isUsablePage(page)) {
        return [{ title, url: item.url!, content: selectRelevant(page, terms, MAX_CONTENT_CHARS) }];
      }
      // The page could not be read (a consent, login or age wall, or it timed
      // out), but the search engine's own title and snippet for it are real
      // and often hold the answer.
      const snippet = item.description?.trim() ?? "";
      if (snippet.length >= MIN_SNIPPET_CHARS || terms.some((term) => title.toLowerCase().includes(term))) {
        return [{ title, url: item.url!, content: `Search result only (the page itself could not be read). Title: ${title}. Snippet: ${snippet || "(none)"}` }];
      }
      return [];
    })
    .slice(0, KEEP);
}

/** Lowercase words of the query worth matching against page text. */
function searchTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().replace(/site:\S+/g, " ").match(/[\p{L}\p{N}]{3,}/gu) ?? [])];
}

const wordCount = (line: string) => line.split(/\s+/).filter(Boolean).length;

/**
 * Page text without navigation: language pickers, menu items, image-only and
 * link-only lines. What is left is prose, headings and lines carrying numbers
 * or dates (a video list: "New video title · 3 days ago").
 */
export function cleanPage(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      if (!line || /^!\[[^\]]*\]\([^)]*\)$/.test(line)) return false;
      const text = line.replace(/^[*\-+#>\d.\s]+/, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
      if (!text) return false;
      if (/^#{1,6}\s/.test(line)) return true;
      return wordCount(text) >= 5 || (wordCount(text) >= 2 && /\d/.test(text));
    })
    .join("\n");
}

/**
 * Up to `max` characters of the page, preferring lines that mention the search
 * terms over the page's first lines, kept in page order. A long page's answer
 * is rarely in its first few thousand characters.
 */
export function selectRelevant(text: string, terms: string[], max: number): string {
  if (text.length <= max) return text;
  const lines = text.split("\n");
  const score = (line: string) => {
    const lower = line.toLowerCase();
    return terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
  };
  const ranked = lines
    .map((line, index) => ({ index, score: score(line) + (index < 3 ? 0.5 : 0) }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const picked = new Set<number>();
  let size = 0;
  for (const { index } of ranked) {
    if (size + lines[index].length + 1 > max) continue;
    picked.add(index);
    size += lines[index].length + 1;
  }
  return lines.filter((_, index) => picked.has(index)).join("\n");
}

// Pages that are only a gate in front of the content.
const GATE_PATTERNS = [
  /before you continue to/i,
  /we use cookies/i,
  /accept (all )?cookies/i,
  /consent\.(youtube|google)\.com/i,
  /log ?in to (see|continue|view)/i,
  /sign ?in to (see|continue|view)/i,
  /melde dich an|anmelden|ein google-unternehmen/i,
  /enable javascript/i,
  // Adult and age-restricted sites put an age check in front of every page.
  /adults only|age[- ]restricted|at least 18 years|age of majority|are you (over )?18|i am (over )?18|age verification/i,
  /verify (that )?you are (a )?human/i,
  /access denied/i,
];

/** False for stubs, cookie and consent walls, login walls and bot checks. Pass text through cleanPage first. */
export function isUsablePage(content: string): boolean {
  const text = content.trim();
  if (text.length < MIN_CONTENT_CHARS) return false;
  // A long article may mention cookies in its footer; only a short page that
  // is mostly the gate is dropped.
  return !(text.length < 2000 && GATE_PATTERNS.some((pattern) => pattern.test(text)));
}
