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

// ── Agent using Anthropic API + All Ears MCP connector ────────────────────────
async function runAgentLoop(keyword) {
  const today = new Date().toISOString().split("T")[0];
  const startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "mcp-client-2025-11-20",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 4000,
      system: `You are a media intelligence analyst with access to All Ears MCP tools.

Build an influence map by following these steps:
1. Call v2_live_get_mentions with keywords=["${keyword}"], page_size=20, start_date=${startDate}, end_date=${today} to sample snippets. Check for noise.
2. If noisy: add near_keywords. If clean: proceed without filters.
3. Call v2_live_top_sources with keywords=["${keyword}"], size=50, start_date=${startDate}, end_date=${today}.
4. Call v2_live_top_terms with keywords=["${keyword}"], size=50, start_date=${startDate}, end_date=${today}.
5. If fewer than 5 sources returned, retry without filters.
6. Generate 3 specific strategic insights referencing actual channel names.

Return ONLY this JSON (no markdown, no preamble):
{
  "refined": true/false,
  "explanation": "noise found and how filtered, or null",
  "nearKeywords": [],
  "notNearKeywords": [],
  "episodeCount": number or null,
  "creators": [{"creator": "channel name", "value": episode_count}],
  "sources": [{"channel_name_slug": "channel_name_lowercased", "value": episode_count}],
  "terms": [{"term": "word", "score": number}],
  "insights": [{"icon": "emoji", "title": "5 words max", "body": "2 sentences with specific data"}]
}`,
      messages: [{
        role: "user",
        content: `Build an influence map for: "${keyword}"`
      }],
      mcp_servers: [{
        type: "url",
        url: "https://mcp.allears.ai/",
        name: "all-ears",
        authorization_token: "0e102db05004cd002185bae2f54d5fb60014ab99",
      }],
      tools: [{
        type: "mcp_toolset",
        mcp_server_name: "all-ears",
      }],
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);

  const text = data.content?.filter(b => b.type === "text").pop()?.text || "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No JSON in response: ${text.slice(0, 300)}`);
  return JSON.parse(match[0]);
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
