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

const ALL_EARS_KEY = "0e102db05004cd002185bae2f54d5fb60014ab99";
const MCP_URL = "https://mcp.allears.ai";

const SYSTEM_PROMPT = `You are a media intelligence analyst with access to the All Ears spoken media database via MCP tools.

When given a brand or keyword, follow this exact process:

STEP 1 — SAMPLE & CHECK FOR NOISE
Call v2_live_get_mentions with keywords=[keyword], languages=["en"], page_size=12, max_mentions=2, snippet_size=200, include_related=false.
Read snippets carefully. Check for noise: non-English words dominating, homonyms, unrelated common words. Well-known brands like Adidas, Nike, Apple, Puma (sportswear) rarely need filtering.

STEP 2 — REFINE IF NEEDED
If noisy, generate near_keywords (max 8) and not_near_keywords (max 5) to anchor the search.
If clean, proceed with no filters.

STEP 3 — FETCH DATA
Call all three with keywords, languages=["en"], size=20 (plus near/not_near if refined):
- v2_live_top_creators
- v2_live_top_sources
- v2_live_top_terms

STEP 4 — RETRY IF THIN
If fewer than 5 creators returned, filters are too tight. Remove near/not_near and retry all three.

STEP 5 — GENERATE INSIGHTS
Generate 3 strategic insights from creators, sources, and terms.

STEP 6 — RETURN JSON ONLY
Return ONLY this JSON, no markdown, no preamble:
{
  "refined": true/false,
  "explanation": "one sentence or null",
  "nearKeywords": [],
  "notNearKeywords": [],
  "episodeCount": null,
  "creators": [{"creator": "name", "value": number}],
  "sources": [{"channel_name_slug": "slug", "value": number}],
  "terms": [{"term": "word", "score": number}],
  "insights": [{"icon": "emoji", "title": "5 words max", "body": "2 sentences"}]
}`;

// Agent endpoint — runs full loop server-side with MCP access
app.post("/agent", async (req, res) => {
  const { keyword } = req.body;
  if (!keyword) return res.status(400).json({ error: "keyword required" });

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
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
        messages: [{ role: "user", content: `Build an influence map for: "${keyword}"` }],
        mcp_servers: [{
          type: "url",
          url: MCP_URL,
          name: "allears",
          headers: { "x-api-key": ALL_EARS_KEY },
        }],
      }),
    });

    const data = await r.json();

    if (data.error) return res.status(500).json({ error: data.error.message });

    const textBlock = data.content?.filter(b => b.type === "text").pop();
    if (!textBlock) {
      return res.status(500).json({
        error: `No text response. Stop: ${data.stop_reason}. Types: ${data.content?.map(b => b.type).join(", ")}`,
      });
    }

    const match = textBlock.text.match(/\{[\s\S]*\}/);
    if (!match) {
      return res.status(500).json({ error: `No JSON in response: ${textBlock.text.slice(0, 300)}` });
    }

    res.json(JSON.parse(match[0]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Serve React app
app.use(express.static(join(__dirname, "dist")));
app.get("*path", (req, res) => {
  res.sendFile(join(__dirname, "dist", "index.html"));
});

app.listen(PORT, () => console.log(`✅ Running on port ${PORT}`));
