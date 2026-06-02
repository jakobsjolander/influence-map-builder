import "dotenv/config";
import express from "express";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "10mb" }));

const ALL_EARS_KEY = process.env.ALL_EARS_API_KEY || "0e102db05004cd002185bae2f54d5fb60014ab99";
const ALL_EARS_BASE = "https://api.allears.ai";

// ── Call All Ears REST API ────────────────────────────────────────────────────
async function callAllEarsREST(endpoint, params) {
  const url = new URL(`${ALL_EARS_BASE}${endpoint}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) {
      if (Array.isArray(v)) url.searchParams.set(k, v.join(","));
      else url.searchParams.set(k, v);
    }
  });
  const res = await fetch(url.toString(), {
    headers: {
      "Authorization": `Token ${ALL_EARS_KEY}`,
      "Accept": "application/json",
    },
  });
  return res.json();
}

// ── Tool definitions for Claude ───────────────────────────────────────────────
const TOOLS = [
  {
    name: "get_mentions",
    description: "Sample raw mentions for a keyword to check for noise and relevance. Returns snippets of actual spoken content.",
    input_schema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "The brand or topic to search for" },
        languages: { type: "array", items: { type: "string" }, description: "Language codes e.g. ['en']" },
        near_keywords: { type: "array", items: { type: "string" }, description: "Words that must appear nearby" },
        not_near_keywords: { type: "array", items: { type: "string" }, description: "Words that must NOT appear nearby" },
        page_size: { type: "number", description: "Number of results (max 100)" },
      },
      required: ["keyword"],
    },
  },
  {
    name: "get_top_creators",
    description: "Get top podcast/YouTube/TikTok creators talking about a keyword, ranked by episode count.",
    input_schema: {
      type: "object",
      properties: {
        keyword: { type: "string" },
        languages: { type: "array", items: { type: "string" } },
        near_keywords: { type: "array", items: { type: "string" } },
        not_near_keywords: { type: "array", items: { type: "string" } },
      },
      required: ["keyword"],
    },
  },
  {
    name: "get_top_sources",
    description: "Get top channels/shows talking about a keyword, ranked by episode count.",
    input_schema: {
      type: "object",
      properties: {
        keyword: { type: "string" },
        languages: { type: "array", items: { type: "string" } },
        near_keywords: { type: "array", items: { type: "string" } },
        not_near_keywords: { type: "array", items: { type: "string" } },
      },
      required: ["keyword"],
    },
  },
  {
    name: "get_top_terms",
    description: "Get terms that co-occur most distinctively with a keyword in spoken media.",
    input_schema: {
      type: "object",
      properties: {
        keyword: { type: "string" },
        languages: { type: "array", items: { type: "string" } },
        near_keywords: { type: "array", items: { type: "string" } },
        not_near_keywords: { type: "array", items: { type: "string" } },
      },
      required: ["keyword"],
    },
  },
];

// ── Execute tool calls ────────────────────────────────────────────────────────
async function executeTool(name, input) {
  const params = {
    search_term: input.keyword,
    languages: input.languages || ["en"],
    start_date: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
    end_date: new Date().toISOString().split("T")[0],
  };
  if (input.near_keywords?.length) params.near_keywords = input.near_keywords;
  if (input.not_near_keywords?.length) params.not_near_keywords = input.not_near_keywords;

  if (name === "get_mentions") {
    params.page_size = input.page_size || 15;
    const data = await callAllEarsREST("/search/v1/", params);
    // Return simplified snippets
    const results = (data.results || []).map(r => ({
      channel: r.channel?.name,
      channel_type: r.channel?.channel_type,
      text: r.snippets?.[0]?.text || r.text,
    }));
    return { results, count: data.count };
  }

  if (name === "get_top_creators" || name === "get_top_sources" || name === "get_top_terms") {
    // Fetch 100 results and aggregate
    params.page_size = 100;
    const data = await callAllEarsREST("/search/v1/", params);
    const results = data.results || [];

    if (name === "get_top_creators") {
      const counts = {};
      results.forEach(r => {
        const creator = r.channel?.name;
        if (creator) counts[creator] = (counts[creator] || 0) + 1;
      });
      const creators = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([creator, value]) => ({ creator, value }));
      return { creators };
    }

    if (name === "get_top_sources") {
      const counts = {};
      const slugs = {};
      results.forEach(r => {
        const name = r.channel?.name;
        const slug = r.channel?.name?.toLowerCase().replace(/\s+/g, "_") || name;
        if (name) {
          counts[name] = (counts[name] || 0) + 1;
          slugs[name] = slug;
        }
      });
      const sources = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([name, value]) => ({ channel_name_slug: slugs[name], value }));
      return { sources };
    }

    if (name === "get_top_terms") {
      // Extract words from snippets and count frequency
      const wordCounts = {};
      const stopWords = new Set(["the","and","for","that","this","with","are","was","its","use","may","have","from","they","but","not","all","also","more","about","into","will","some","than","when","there","been","other","what","which","their","has","our","we","it","is","in","of","to","a","an","i","you","he","she","they","we","be","do","so","if","at","by","or","as","on","up"]);
      results.forEach(r => {
        const text = (r.snippets?.[0]?.text || r.text || "").toLowerCase().replace(/<[^>]+>/g, "");
        const words = text.match(/\b[a-z]{4,}\b/g) || [];
        words.forEach(w => {
          if (!stopWords.has(w) && w !== input.keyword.toLowerCase()) {
            wordCounts[w] = (wordCounts[w] || 0) + 1;
          }
        });
      });
      const terms = Object.entries(wordCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 25)
        .map(([term, count]) => ({ term, score: count * 10 }));
      return { terms };
    }
  }
}

// ── Agent loop ────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a media intelligence analyst. Use the provided tools to build an influence map for any brand or keyword.

Follow this process:
1. Call get_mentions to sample 15 raw results and check for noise (homonyms, non-English words, unrelated meanings)
2. If noisy, add near_keywords to anchor to the right context. If clean, proceed without filters.
3. Call get_top_creators, get_top_sources, and get_top_terms with the refined query
4. If fewer than 5 creators returned, remove the filters and retry
5. Generate 3 strategic insights from what you found

When done, return ONLY this JSON (no markdown, no preamble):
{
  "refined": true/false,
  "explanation": "what noise was found, or null",
  "nearKeywords": [],
  "notNearKeywords": [],
  "creators": [{"creator": "name", "value": number}],
  "sources": [{"channel_name_slug": "slug", "value": number}],
  "terms": [{"term": "word", "score": number}],
  "insights": [{"icon": "emoji", "title": "5 words max", "body": "2 sentences"}]
}`;

async function runAgentLoop(keyword) {
  const messages = [{ role: "user", content: `Build an influence map for: "${keyword}"` }];

  for (let i = 0; i < 10; i++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      }),
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error.message);

    messages.push({ role: "assistant", content: data.content });

    // If done, extract final JSON
    if (data.stop_reason === "end_turn") {
      const text = data.content.filter(b => b.type === "text").pop()?.text || "";
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error(`No JSON in final response: ${text.slice(0, 200)}`);
      return JSON.parse(match[0]);
    }

    // Execute tool calls
    if (data.stop_reason === "tool_use") {
      const toolResults = [];
      for (const block of data.content) {
        if (block.type === "tool_use") {
          try {
            const result = await executeTool(block.name, block.input);
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify(result),
            });
          } catch (e) {
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: `Error: ${e.message}`,
              is_error: true,
            });
          }
        }
      }
      messages.push({ role: "user", content: toolResults });
    }
  }
  throw new Error("Agent loop exceeded max iterations");
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.post("/agent", async (req, res) => {
  const { keyword } = req.body;
  if (!keyword) return res.status(400).json({ error: "keyword required" });
  try {
    const result = await runAgentLoop(keyword);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use(express.static(join(__dirname, "dist")));
app.get("*path", (req, res) => res.sendFile(join(__dirname, "dist", "index.html")));

app.listen(PORT, () => console.log(`✅ Running on port ${PORT}`));
