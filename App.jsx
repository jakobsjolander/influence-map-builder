import { useState, useRef } from "react";

const ALL_EARS_KEY = "0e102db05004cd002185bae2f54d5fb60014ab99";
const MCP_URL = "https://mcp.allears.ai";

const SYSTEM_PROMPT = `You are a media intelligence analyst with access to the All Ears spoken media database via MCP tools.

When given a brand or keyword, follow this exact process:

STEP 1 — SAMPLE & CHECK FOR NOISE
Call v2_live_get_mentions with:
- keywords: [the keyword]
- languages: ["en"]
- page_size: 12
- max_mentions: 2
- snippet_size: 200
- include_related: false

Read the snippets carefully. Is this predominantly about the intended brand/topic? Watch for:
- Non-English words dominating
- Famous people/animals/places with the same name
- Common everyday words unrelated to any brand
Well-known brands like Adidas, Nike, Apple, Puma (sportswear) should rarely need filtering.

STEP 2 — REFINE IF NEEDED
If noisy, generate near_keywords (max 8) and not_near_keywords (max 5) to anchor the search.
If clean, proceed with no filters.

STEP 3 — FETCH DATA
Call these three tools with the refined query (add near/not_near if refined):
- v2_live_top_creators with keywords, languages=["en"], size=20
- v2_live_top_sources with keywords, languages=["en"], size=20  
- v2_live_top_terms with keywords, languages=["en"], size=25

STEP 4 — CHECK RESULTS & RETRY IF THIN
If creators list has fewer than 5 results, your filters are too tight.
Remove the near_keywords/not_near_keywords and retry all three calls without filters.

STEP 5 — GENERATE INSIGHTS
Based on the creators, sources, and terms you found, generate 3 strategic insights.

STEP 6 — RETURN STRUCTURED JSON
Return ONLY this exact JSON structure, nothing else:
{
  "refined": true/false,
  "explanation": "one sentence about what noise was found, or null if clean",
  "nearKeywords": ["word1"] or [],
  "notNearKeywords": ["word1"] or [],
  "episodeCount": number or null,
  "creators": [{"creator": "name", "value": number}, ...],
  "sources": [{"channel_name_slug": "slug", "value": number}, ...],
  "terms": [{"term": "word", "score": number}, ...],
  "insights": [{"icon": "emoji", "title": "5 words max", "body": "2 sentences actionable"}, ...]
}

Critical: Return ONLY the JSON object. No markdown, no explanation, no preamble.`;

// ── Tier classification ────────────────────────────────────────────────────────
function classifyCreators(list) {
  const f = list.filter(c => c.creator?.trim());
  if (!f.length) return { mega: [], specialist: [], rising: [] };
  const max = f[0].value;
  return {
    mega: f.filter(c => c.value >= max * 0.4),
    specialist: f.filter(c => c.value >= max * 0.1 && c.value < max * 0.4),
    rising: f.filter(c => c.value < max * 0.1),
  };
}
function classifySources(list) {
  const f = list.filter(s => s.channel_name_slug);
  if (!f.length) return { dominant: [], regular: [], niche: [] };
  const max = f[0].value;
  return {
    dominant: f.filter(s => s.value >= max * 0.4),
    regular: f.filter(s => s.value >= max * 0.1 && s.value < max * 0.4),
    niche: f.filter(s => s.value < max * 0.1),
  };
}
function slugToName(s) {
  return s.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase());
}

// ── Main agent call ────────────────────────────────────────────────────────────
async function runAgent(keyword, onStage) {
  onStage("Sampling mentions…");

  const res = await fetch("/api/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Build an influence map for: "${keyword}"` }],
      mcp_servers: [{ type: "url", url: MCP_URL, name: "allears", headers: { "x-api-key": ALL_EARS_KEY } }],
    }),
  });

  const data = await res.json();

  // Find the final text response
  const textBlock = data.content?.filter(b => b.type === "text").pop();
  if (!textBlock) throw new Error("No response from agent");

  const text = textBlock.text.trim();

  // Parse JSON from response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Could not parse agent response");

  return JSON.parse(jsonMatch[0]);
}

// ── Sub-components ─────────────────────────────────────────────────────────────
function Bar({ value, max }) {
  const pct = Math.max(3, Math.round((value / max) * 100));
  return (
    <div className="bar-track">
      <div className="bar-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

function CreatorRow({ creator, value, tier, max }) {
  return (
    <div className={`row-item tier-${tier}`}>
      <div className="row-left">
        <span className={`tier-dot dot-${tier}`} />
        <span className="row-name">{creator}</span>
      </div>
      <span className="row-count">{value}</span>
      <Bar value={value} max={max} />
    </div>
  );
}

function SourceRow({ slug, value, tier, max }) {
  return (
    <div className={`row-item tier-${tier}`}>
      <div className="row-left">
        <span className={`tier-dot dot-${tier}`} />
        <span className="row-name">{slugToName(slug)}</span>
      </div>
      <span className="row-count">{value}</span>
      <Bar value={value} max={max} />
    </div>
  );
}

function InsightCard({ icon, title, body }) {
  return (
    <div className="insight-card">
      <span className="insight-icon">{icon}</span>
      <div>
        <div className="insight-title">{title}</div>
        <div className="insight-body">{body}</div>
      </div>
    </div>
  );
}

function DisambigBanner({ result }) {
  if (!result?.refined) return null;
  return (
    <div className="disambig-banner">
      <div className="disambig-header">
        <span className="disambig-label">Query refined automatically</span>
        {result.episodeCount && <span className="disambig-count">{result.episodeCount} episodes after filtering</span>}
      </div>
      <p className="disambig-explanation">{result.explanation}</p>
      <div className="disambig-tags">
        {result.nearKeywords?.map(k => <span key={k} className="tag tag-near">{k}</span>)}
        {result.notNearKeywords?.map(k => <span key={k} className="tag tag-notnear">−{k}</span>)}
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function App() {
  const [input, setInput] = useState("");
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState("");
  const [tab, setTab] = useState("creators");
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  async function run() {
    if (!input.trim() || loading) return;
    const kw = input.trim();
    setKeyword(kw);
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const data = await runAgent(kw, setStage);
      setResult(data);
      setTab("creators");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
      setStage("");
    }
  }

  const creators = result?.creators || [];
  const sources = result?.sources || [];
  const terms = (result?.terms || []).filter(t => {
    const stop = new Set(["the","and","for","that","this","with","are","was","its","use","may","have","from","they","but","not","all","also","more","about","into","will","some","than","when","there","been","other","what","which","their","has"]);
    return !stop.has(t.term) && t.term !== keyword.toLowerCase();
  });

  const ct = classifyCreators(creators);
  const st = classifySources(sources);
  const cMax = Math.max(...creators.map(c => c.value), 1);
  const sMax = Math.max(...sources.map(s => s.value), 1);

  return (
    <div className="root">
      <div className="blob blob-1" />
      <div className="blob blob-2" />

      <div className="shell">
        <header className="header">
          <div className="overline">All Ears · Influence Intelligence</div>
          <h1 className="display">Influence<br />Map Builder</h1>
          <p className="subtitle">Enter any brand or topic. The agent autonomously samples mentions, detects noise, refines the query, then maps who owns the spoken media conversation.</p>
        </header>

        <div className="search-block">
          <input
            ref={inputRef}
            className="search-input"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && run()}
            placeholder="e.g. Puma, Ozempic, electric vehicles…"
          />
          <button className="search-btn" onClick={run} disabled={loading || !input.trim()}>
            {loading ? <span className="spinner" /> : "Build Map"}
          </button>
        </div>

        {loading && (
          <div className="loading-block">
            <div className="loading-dots"><span /><span /><span /></div>
            <p className="loading-stage">{stage}</p>
          </div>
        )}

        {error && <div className="error-block">{error}</div>}

        {result && !loading && (
          <div className="results">
            <div className="keyword-divider">
              <div className="divider-line" />
              <span className="keyword-pill">"{keyword}"</span>
              <div className="divider-line" />
            </div>

            <DisambigBanner result={result} />

            {result.insights?.length > 0 && (
              <section className="insights-section">
                <div className="section-label">Strategic Insights</div>
                <div className="insights-grid">
                  {result.insights.map((ins, i) => <InsightCard key={i} {...ins} />)}
                </div>
              </section>
            )}

            <div className="legend">
              {[["mega","Mega / Dominant"],["specialist","Specialist / Regular"],["rising","Rising / Niche"]].map(([k,l]) => (
                <div key={k} className="legend-item">
                  <span className={`tier-dot dot-${k}`} />
                  <span className="legend-label">{l}</span>
                </div>
              ))}
            </div>

            <div className="tabs">
              {["creators","channels","themes"].map(t => (
                <button key={t} className={`tab ${tab === t ? "tab-active" : ""}`} onClick={() => setTab(t)}>
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>

            {tab === "creators" && (
              <div className="list-section">
                {[["mega",ct.mega,"Mega Voices"],["specialist",ct.specialist,"Specialists"],["rising",ct.rising,"Rising Voices"]].filter(([,items]) => items.length).map(([tier, items, label]) => (
                  <div key={tier} className="tier-group">
                    <div className="tier-label">
                      <span className={`tier-dot dot-${tier}`} />
                      {label} <span className="tier-count">({items.length})</span>
                    </div>
                    <div className="rows">
                      {items.map((c, i) => <CreatorRow key={i} creator={c.creator} value={c.value} tier={tier} max={cMax} />)}
                    </div>
                  </div>
                ))}
                {creators.length === 0 && <p className="empty-msg">No creators found.</p>}
              </div>
            )}

            {tab === "channels" && (
              <div className="list-section">
                {[["dominant",st.dominant,"Dominant Channels"],["regular",st.regular,"Regular Channels"],["niche",st.niche,"Niche Channels"]].filter(([,items]) => items.length).map(([tier, items, label]) => (
                  <div key={tier} className="tier-group">
                    <div className="tier-label">
                      <span className={`tier-dot dot-${tier}`} />
                      {label} <span className="tier-count">({items.length})</span>
                    </div>
                    <div className="rows">
                      {items.map((s, i) => <SourceRow key={i} slug={s.channel_name_slug} value={s.value} tier={tier} max={sMax} />)}
                    </div>
                  </div>
                ))}
                {sources.length === 0 && <p className="empty-msg">No channels found.</p>}
              </div>
            )}

            {tab === "themes" && (
              <div className="themes-section">
                {terms.length > 1 ? (
                  <>
                    <div className="section-label">Co-occurring terms · opacity = statistical significance</div>
                    <div className="terms-cloud">
                      {terms.map((t, i) => {
                        const op = Math.max(0.3, Math.min(1, t.score / 300));
                        return <span key={i} className="term-pill" style={{ opacity: op }}>{t.term}</span>;
                      })}
                    </div>
                    <p className="terms-note">Terms appearing distinctively alongside "{keyword}" — weighted by statistical co-occurrence.</p>
                  </>
                ) : (
                  <div className="empty-themes">
                    <div className="empty-icon">🔬</div>
                    <p className="empty-title">Corpus too narrow for theme analysis</p>
                    <p className="empty-body">The episode set is too small for statistically significant co-occurrence patterns.</p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {!result && !loading && !error && (
          <div className="empty-state">
            <div className="empty-glyph">◈</div>
            <p className="empty-state-text">Enter a keyword to build your influence map</p>
            <p className="empty-state-sub">Powered by All Ears · Real-time spoken media intelligence</p>
          </div>
        )}
      </div>
    </div>
  );
}
