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

// ── Date helpers ──────────────────────────────────────────────────────────────
const today = () => new Date().toISOString().split("T")[0];
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

// ── Call All Ears REST API ────────────────────────────────────────────────────
async function callAllEars(endpoint, params) {
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
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`All Ears API error ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ── Tool definitions for Claude ───────────────────────────────────────────────
const TOOLS = [
  {
    name: "sample_mentions",
    description: "Sample 20 raw mention snippets for a keyword to check for noise and relevance. Use this first to decide if the keyword needs filtering.",
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
    description: "Get top channels/shows talking about a keyword. Returns up to 50 channels ranked by episode count via the MCP aggregation layer.",
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
    description: "Get terms that co-occur most distinctively with a keyword. Returns statistically significant co-occurring terms via the MCP aggregation layer.",
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
  const base = {
    search_term: input.keyword,
    languages: input.languages || ["en"],
    start_date: daysAgo(90),
    end_date: today(),
  };
  if (input.near_keywords?.length) base.near_keywords = input.near_keywords;
  if (input.not_near_keywords?.length) base.not_near_keywords = input.not_near_keywords;

  // ── Sample raw mentions for noise detection (direct REST) ────────────────
  if (name === "sample_mentions") {
    const data = await callAllEars("/search/v1/", { ...base, page_size: 20 });
    return {
      results: (data.results || []).map(r => ({
        channel: r.channel?.name,
        channel_type: r.channel?.channel_type,
        text: r.snippets?.[0]?.text || r.text || "",
      })),
      total: data.count,
    };
  }

  // ── Top sources + terms via n8n → All Ears MCP ──────────────────────────
  if (name === "get_top_sources" || name === "get_top_terms") {
    const n8nRes = await fetch("https://jakosjol.app.n8n.cloud/webhook/influence-map", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keyword: input.keyword,
        near_keywords: input.near_keywords || [],
        not_near_keywords: input.not_near_keywords || [],
        languages: input.languages || ["en"],
      }),
    });
    if (!n8nRes.ok) {
      throw new Error(`n8n webhook error ${n8nRes.status}`);
    }
    const n8nData = await n8nRes.json();
    if (name === "get_top_sources") return { sources: n8nData.sources || [] };
    if (name === "get_top_terms") return { terms: n8nData.terms || [] };
  }
}

// ── Agent system prompt ───────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a media intelligence analyst. Use the provided tools to build an influence map for any brand or keyword.

Follow this exact process:
1. Call sample_mentions to get 20 raw snippets. Check if results are noisy (wrong meaning, wrong language, homonyms).
2. If noisy: add near_keywords to anchor context. If clean: proceed without filters.
3. Call get_top_sources with the refined query to get channels ranked by episode count.
4. Call get_top_terms with the same query to get co-occurring terms.
5. If get_top_sources returns fewer than 5 results, retry without near/not_near filters.
6. Generate 3 strategic insights — be specific, reference actual channel names or patterns you observed.

Return ONLY this JSON when done (no markdown fences, no preamble):
{
  "refined": true/false,
  "explanation": "what noise was found and how you filtered it, or null if clean",
  "nearKeywords": [],
  "notNearKeywords": [],
  "episodeCount": number or null,
  "creators": [],
  "sources": [{"channel_name_slug": "slug", "value": number}],
  "terms": [{"term": "word", "score": number}],
  "insights": [{"icon": "emoji", "title": "5 words max", "body": "2 specific sentences referencing actual data"}]
}

Note: creators and sources come from the same get_top_sources call. Map the results to both fields identically so the UI can display them.`;

// ── Agent loop ────────────────────────────────────────────────────────────────
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

    if (data.stop_reason === "end_turn") {
      const text = data.content.filter(b => b.type === "text").pop()?.text || "";
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error(`No JSON in final response: ${text.slice(0, 300)}`);
      return JSON.parse(match[0]);
    }

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
    console.error("Agent error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.use(express.static(join(__dirname, "dist")));
app.get("*path", (req, res) => res.sendFile(join(__dirname, "dist", "index.html")));

app.listen(PORT, () => console.log(`✅ Running on port ${PORT}`));
