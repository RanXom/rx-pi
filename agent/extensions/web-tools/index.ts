/**
 * web-tools — search and read the web without leaving pi.
 *
 *   web_search: DuckDuckGo HTML, falling back to Google Custom Search when
 *               GOOGLE_SEARCH_API_KEY/GOOGLE_API_KEY + GOOGLE_CSE_ID are set.
 *   fetch_url:  Readability + Turndown, with r.jina.ai as a fallback for
 *               pages that need JavaScript or are PDFs.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DOMParser, parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const MAX_CHARS = 40000;

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

function decodeDdg(href: string): string {
  try {
    const url = new URL(href, "https://duckduckgo.com");
    const target = url.searchParams.get("uddg");
    return target ? decodeURIComponent(target) : url.toString();
  } catch {
    return href;
  }
}

async function duckduckgo(query: string, limit: number, signal?: AbortSignal): Promise<SearchHit[]> {
  const response = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "user-agent": UA,
      "content-type": "application/x-www-form-urlencoded",
      accept: "text/html",
    },
    body: new URLSearchParams({ q: query }).toString(),
    signal,
  });
  if (!response.ok) throw new Error(`DuckDuckGo returned ${response.status}`);
  const { document } = parseHTML(await response.text());
  const hits: SearchHit[] = [];
  for (const node of document.querySelectorAll(".result")) {
    const link = node.querySelector("a.result__a");
    if (!link) continue;
    const href = link.getAttribute("href") || "";
    const snippet = node.querySelector(".result__snippet")?.textContent?.trim() || "";
    if (!href || href.startsWith("https://duckduckgo.com/y.js")) continue;
    hits.push({
      title: link.textContent?.trim() || href,
      url: decodeDdg(href),
      snippet,
      source: "duckduckgo",
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

async function bing(query: string, limit: number, signal?: AbortSignal): Promise<SearchHit[]> {
  // Bing's RSS output gives clean result URLs with no tracking wrappers.
  const url = new URL("https://www.bing.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "rss");
  url.searchParams.set("count", String(Math.min(limit, 10)));
  const response = await fetch(url, { headers: { "user-agent": UA }, signal });
  if (!response.ok) throw new Error(`Bing returned ${response.status}`);
  const document = new DOMParser().parseFromString(await response.text(), "text/xml");
  return [...document.querySelectorAll("item")]
    .slice(0, limit)
    .map((item) => ({
      title: item.querySelector("title")?.textContent?.trim() || "",
      url: item.querySelector("link")?.textContent?.trim() || "",
      snippet: (item.querySelector("description")?.textContent || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      source: "bing",
    }))
    .filter((hit) => hit.url.startsWith("http"));
}

async function google(query: string, limit: number, signal?: AbortSignal): Promise<SearchHit[]> {
  const key = process.env.GOOGLE_SEARCH_API_KEY ?? process.env.GOOGLE_API_KEY;
  const cx = process.env.GOOGLE_CSE_ID ?? process.env.GOOGLE_CUSTOM_SEARCH_ENGINE_ID;
  if (!key || !cx) return [];
  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", key);
  url.searchParams.set("cx", cx);
  url.searchParams.set("q", query);
  url.searchParams.set("num", String(Math.min(limit, 10)));
  const response = await fetch(url, { signal });
  if (!response.ok) return [];
  const data: any = await response.json();
  return (data.items ?? []).map((item: any) => ({
    title: item.title,
    url: item.link,
    snippet: item.snippet ?? "",
    source: "google",
  }));
}

async function search(query: string, limit: number, signal?: AbortSignal): Promise<SearchHit[]> {
  // DuckDuckGo's HTML endpoints answer 202 bot challenges from many networks,
  // so Bing RSS is the default keyless provider. Set PI_SEARCH_PROVIDERS to
  // reorder or re-enable providers, e.g. "ddg,bing,google".
  const order = (process.env.PI_SEARCH_PROVIDERS || "bing,google")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const errors: string[] = [];
  for (const provider of order) {
    try {
      const hits =
        provider === "ddg" || provider === "duckduckgo"
          ? await duckduckgo(query, limit, signal)
          : provider === "bing"
            ? await bing(query, limit, signal)
            : provider === "google"
              ? await google(query, limit, signal)
              : [];
      if (hits.length) return hits;
      errors.push(`${provider}: no results`);
    } catch (error: any) {
      errors.push(`${provider}: ${error.message}`);
    }
  }
  throw new Error(errors.join("; ") || "no search providers configured");
}

function htmlToMarkdown(html: string, url: string): { title: string; markdown: string } {
  const { document } = parseHTML(html);
  const article = new Readability(document as any, { charThreshold: 200 }).parse();
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  if (article?.content) {
    const markdown = turndown.turndown(article.content);
    return { title: article.title || url, markdown };
  }
  const body = document.body?.textContent ?? "";
  return { title: document.title || url, markdown: body.replace(/\s+/g, " ").trim() };
}

async function jina(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(`https://r.jina.ai/${url}`, {
    headers: { "user-agent": UA, accept: "text/plain" },
    signal,
  });
  if (!response.ok) throw new Error(`r.jina.ai returned ${response.status}`);
  return response.text();
}

async function fetchPage(
  url: string,
  maxChars: number,
  signal?: AbortSignal,
): Promise<{ title: string; url: string; text: string }> {
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("only http(s) URLs are supported");

  let response: Response | null = null;
  let failure = "";
  try {
    response = await fetch(parsed, {
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8" },
      redirect: "follow",
      signal,
    });
  } catch (error: any) {
    failure = error.message;
  }

  const type = response?.headers.get("content-type") ?? "";
  if (response?.ok && (type.includes("application/pdf") || parsed.pathname.toLowerCase().endsWith(".pdf"))) {
    const text = await jina(url, signal);
    return { title: url, url, text: `[PDF extracted via r.jina.ai]\n\n${text.slice(0, maxChars)}` };
  }

  if (response?.ok && type.includes("text/html")) {
    const html = await response.text();
    const { title, markdown } = htmlToMarkdown(html, url);
    if (markdown.trim().length >= 400) {
      return { title, url, text: markdown.slice(0, maxChars) };
    }
    failure = "page had too little readable text";
  } else if (response?.ok && (type.includes("text/plain") || type.includes("application/json") || type.includes("text/markdown"))) {
    return { title: url, url, text: (await response.text()).slice(0, maxChars) };
  } else if (response) {
    failure = `HTTP ${response.status} ${response.statusText}`;
  }

  // Fallback: reader service renders JS and extracts PDFs.
  const text = await jina(url, signal);
  return {
    title: url,
    url,
    text: `[fetched via r.jina.ai${failure ? ` after ${failure}` : ""}]\n\n${text.slice(0, maxChars)}`,
  };
}

function formatHits(hits: SearchHit[]): string {
  return hits
    .map((hit, index) => `${index + 1}. ${hit.title}\n   ${hit.url}\n   ${hit.snippet}`)
    .join("\n\n");
}

export default function webTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web search",
    description:
      "Search the web. Returns titles, URLs, and snippets. After picking sources, call fetch_url to read them in full.",
    promptSnippet: "Search the web for current information (DuckDuckGo, Google fallback).",
    promptGuidelines: [
      "Use web_search for anything time-sensitive or outside the repository.",
      "Read the 1-3 most promising results with fetch_url before drawing conclusions.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query." }),
      maxResults: Type.Optional(Type.Number({ description: "Number of results (default 6, max 10)." })),
    }),
    async execute(_id, params, signal) {
      const limit = Math.max(1, Math.min(10, params.maxResults ?? 6));
      try {
        const hits = await search(params.query, limit, signal);
        if (!hits.length) {
          return { content: [{ type: "text", text: `No results for "${params.query}".` }], details: { count: 0 } };
        }
        return { content: [{ type: "text", text: formatHits(hits) }], details: { count: hits.length } };
      } catch (error: any) {
        return { content: [{ type: "text", text: `Search failed: ${error.message}` }], details: { error: true } };
      }
    },
  });

  pi.registerTool({
    name: "fetch_url",
    label: "Fetch URL",
    description:
      "Fetch a web page or PDF and return clean markdown. Uses Readability extraction, with a reader-service fallback for JS-heavy pages.",
    promptSnippet: "Read a web page as clean markdown.",
    parameters: Type.Object({
      url: Type.String({ description: "Absolute http(s) URL to read." }),
      maxChars: Type.Optional(Type.Number({ description: "Maximum characters to return (default 30000)." })),
    }),
    async execute(_id, params, signal) {
      const limit = Math.max(2000, Math.min(MAX_CHARS, params.maxChars ?? 30000));
      try {
        const page = await fetchPage(params.url, limit, signal);
        return {
          content: [{ type: "text", text: `# ${page.title}\n${page.url}\n\n${page.text}` }],
          details: { chars: page.text.length },
        };
      } catch (error: any) {
        return { content: [{ type: "text", text: `Fetch failed: ${error.message}` }], details: { error: true } };
      }
    },
  });
}
