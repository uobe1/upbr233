import type { ToolConfig } from "../types";

export const webFetchTool: ToolConfig = {
  name: "web_fetch",
  description: "Fetch the content of a URL and extract readable text.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to fetch" },
      maxChars: { type: "number", description: "Maximum characters to return (default: 20000)" },
    },
    required: ["url"],
  },
  requiresApproval: false,
  handler: async (input) => {
    try {
      const url = input.url as string;
      const maxChars = (input.maxChars as number) || 20000;

      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        return {
          id: "",
          toolName: "web_fetch",
          output: "Error: URL must start with http:// or https://",
          isError: true,
        };
      }

      const resp = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: {
          "User-Agent": "UPBR233-CodingAgent/0.1",
        },
      });

      if (!resp.ok) {
        return {
          id: "",
          toolName: "web_fetch",
          output: `HTTP ${resp.status}: ${resp.statusText}`,
          isError: true,
        };
      }

      const contentType = resp.headers.get("content-type") || "";
      if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
        return {
          id: "",
          toolName: "web_fetch",
          output: `Unsupported content type: ${contentType}. Only text/html and text/plain are supported.`,
          isError: true,
        };
      }

      const html = await resp.text();

      // Basic HTML to text conversion
      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .replace(/\n\s*\n/g, "\n")
        .trim();

      const truncated = text.slice(0, maxChars);

      return {
        id: "",
        toolName: "web_fetch",
        output: `Title: ${extractTitle(html)}\nURL: ${url}\n\n${truncated}${text.length > maxChars ? `\n\n[Truncated: ${text.length - maxChars} more characters]` : ""}`,
        isError: false,
        metadata: { title: extractTitle(html), contentLength: text.length },
      };
    } catch (e) {
      return {
        id: "",
        toolName: "web_fetch",
        output: `Error fetching URL: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
  },
};

export const webSearchTool: ToolConfig = {
  name: "web_search",
  description: "Search the web using DuckDuckGo (no API key required).",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      maxResults: { type: "number", description: "Maximum results (default: 10)" },
    },
    required: ["query"],
  },
  requiresApproval: false,
  handler: async (input) => {
    // Note: In a production environment, this would use a proper search API
    // This is a placeholder that uses DuckDuckGo's HTML search
    try {
      const query = encodeURIComponent(input.query as string);
      const maxResults = (input.maxResults as number) || 10;

      // DuckDuckGo Lite search
      const resp = await fetch(`https://lite.duckduckgo.com/lite/?q=${query}`, {
        signal: AbortSignal.timeout(10000),
        headers: { "User-Agent": "UPBR233-CodingAgent/0.1" },
      });

      const html = await resp.text();

      // Simple extraction of results
      const linkRegex = /<a[^>]*class="result-link"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi;
      const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;

      const links: string[] = [];
      const snippets: string[] = [];

      let match;
      while ((match = linkRegex.exec(html)) !== null) {
        if (links.length >= maxResults) break;
        links.push(`${match[2].trim()} - ${match[1]}`);
      }

      while ((match = snippetRegex.exec(html)) !== null) {
        if (snippets.length >= maxResults) break;
        const snippet = match[1]!.replace(/<[^>]+>/g, "").trim();
        if (snippet) snippets.push(snippet);
      }

      const results: string[] = [];
      for (let i = 0; i < Math.min(links.length, snippets.length); i++) {
        results.push(`${i + 1}. ${links[i]}\n   ${snippets[i]}`);
      }

      return {
        id: "",
        toolName: "web_search",
        output: results.length > 0
          ? `Search results for "${input.query}":\n\n${results.join("\n\n")}`
          : `No results found for "${input.query}"`,
        isError: false,
      };
    } catch (e) {
      return {
        id: "",
        toolName: "web_search",
        output: `Search error: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
  },
};

function extractTitle(html: string): string {
  const match = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  return match ? match[1]!.trim() : "Untitled";
}
