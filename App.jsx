import { useState, useRef } from "react";

const MCP_URL = "https://mcp.allears.ai";
const ALL_EARS_KEY = "0e102db05004cd002185bae2f54d5fb60014ab99";

// ── Helpers ────────────────────────────────────────────────────────────────────
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
function slug(s) {
  return s.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase());
}

// ── API calls ──────────────────────────────────────────────────────────────────
async function callClaude(messages, system) {
  const body = { model: "claude-sonnet-4-5", max_tokens: 1000, messages };
  if (system) body.system = system;
  const res = await fetch("/api/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data.content?.find(b => b.type === "text")?.text || "";
}

async function callAllEars(prompt) {
  const res = await fetch("/api/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 1000,
      mcp_servers: [{ type: "url", url: MCP_URL, name: "allears", "x-api-key": ALL_EARS_KEY }],
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  const block = data.content?.find(b => b.type === "mcp_tool_result");
  if (!block) return null;
  try { return JSON.parse(block.content?.[0]?.text || "{}"); } catch { return null; }
}

// ── Disambiguation ─────────────────────────────────────────────────────────────
async function disambiguate(keyword, onStage) {
  onStage("Sampling raw mentions…");
  const raw = await callAllEars(
    `Use v2_live_get_mentions with keywords=["${keyword}"], languages=["en"], page_size=12, max_mentions=2, snippet_size=200, include_related=false. Return ONLY the raw JSON.`
  );
  const snippets = (raw?.results || [])
    .flatMap(r => (r.snippets || []).map(s => s.text.replace(/<\/?b>/g, "")))
    .slice(0, 15).join("\n---\n");
  if (!snippets) return { nearKeywords: null, notNearKeywords: null, refined: false };

  onStage("Checking for noise…");
  const judgement = await callClaude(
    [{ role: "user", content: `You are a media analyst. Keyword: "${keyword}". Snippets:\n${snippets}\n\nAre these predominantly about the intended brand/topic? Return ONLY JSON: {"isAmbiguous":bool,"explanation":"one sentence","nearKeywords":[],"notNearKeywords":[]}. Max 8 near, 5 not-near. If clean return empty arrays.` }],
    "Return only valid JSON, no markdown."
  );
  let parsed;
  try { parsed = JSON.parse(judgement.replace(/```json|```/g, "").trim()); } catch { return { nearKeywords: null, notNearKeywords: null, refined: false }; }
  if (!parsed.isAmbiguous) return { nearKeywords: null, notNearKeywords: null, refined: false };

  onStage("Refining query…");
  const countData = await callAllEars(
    `Use v2_live_episode_count with keywords=["${keyword}"], languages=["en"]${parsed.nearKeywords?.length ? `, near_keywords=${JSON.stringify(parsed.nearKeywords)}` : ""}${parsed.notNearKeywords?.length ? `, not_near_keywords=${JSON.stringify(parsed.notNearKeywords)}` : ""}. Return ONLY the raw JSON.`
  );
  return { nearKeywords: parsed.nearKeywords?.length ? parsed.nearKeywords : null, notNearKeywords: parsed.notNearKeywords?.length ? parsed.notNearKeywords : null, refined: true, explanation: parsed.explanation, episodeCount: countData?.episode_count || 0 };
}

function buildFilters(near, notNear) {
  let s = `, languages=["en"]`;
  if (near?.length) s += `, near_keywords=${JSON.stringify(near)}`;
  if (notNear?.length) s += `, not_near_keywords=${JSON.stringify(notNear)}`;
  return s;
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

function SourceRow({ slug: s, value, tier, max }) {
  return (
    <div className={`row-item tier-${tier}`}>
      <div className="row-left">
        <span className={`tier-dot dot-${tier}`} />
        <span className="row-name">{slug(s)}</span>
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

function DisambigBanner({ info }) {
  if (!info) return null;
  return (
    <div className="disambig-banner">
      <div className="disambig-header">
        <span className="disambig-label">Query refined automatically</span>
        <span className="disambig-count">{info.episodeCount} episodes after filtering</span>
      </div>
      <p className="disambig-explanation">{info.explanation}</p>
      <div className="disambig-tags">
        {info.nearKeywords?.map(k => <span key={k} className="tag tag-near">{k}</span>)}
        {info.notNearKeywords?.map(k => <span key={k} className="tag tag-notnear">−{k}</span>)}
      </div>
    </div>
  );
}

// ── Main ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [input, setInput] = useState("");
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState("");
  const [tab, setTab] = useState("creators");
  const [creators, setCreators] = useState(null);
  const [sources, setSources] = useState(null);
  const [terms, setTerms] = useState(null);
  const [insights, setInsights] = useState(null);
  const [disambig, setDisambig] = useState(null);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  async function run() {
    if (!input.trim() || loading) return;
    const kw = input.trim();
    setKeyword(kw); setLoading(true); setError(null);
    setCreators(null); setSources(null); setTerms(null); setInsights(null); setDisambig(null);
    try {
      const d = await disambiguate(kw, setStage);
      if (d.refined) setDisambig(d);
      const f = buildFilters(d.nearKeywords, d.notNearKeywords);

      setStage("Mapping creators…");
      const cd = await callAllEars(`Use v2_live_top_creators with keywords=["${kw}"]${f}, size=20. Return ONLY the raw JSON.`);
      setCreators(cd?.creators || []);

      setStage("Mapping channels…");
      const sd = await callAllEars(`Use v2_live_top_sources with keywords=["${kw}"]${f}, size=20. Return ONLY the raw JSON.`);
      setSources(sd?.sources || []);

      setStage("Extracting themes…");
      const stop = new Set(["the","and","for","that","this","with","are","was","its","use","may","have","from","they","but","not","all","also","more","about","into","will","some","than","when","there","been","other","what","which","their","has"]);
      const td = await callAllEars(`Use v2_live_top_terms with keywords=["${kw}"]${f}, size=30. Return ONLY the raw JSON.`);
      setTerms((td?.terms || []).filter(t => !stop.has(t.term) && t.term !== kw.toLowerCase()));

      setStage("Generating insights…");
      const cStr = (cd?.creators || []).filter(c => c.creator).slice(0, 8).map(c => `${c.creator} (${c.value})`).join(", ");
      const sStr = (sd?.sources || []).filter(s => s.channel_name_slug).slice(0, 8).map(s => `${slug(s.channel_name_slug)} (${s.value})`).join(", ");
      const tStr = (td?.terms || []).slice(0, 12).map(t => t.term).join(", ");
      const raw = await callClaude(
        [{ role: "user", content: `Media intelligence analyst. Keyword: "${kw}". Creators: ${cStr}. Channels: ${sStr}. Terms: ${tStr}. Generate 3 strategic insights as JSON array: [{"icon":"emoji","title":"5 words max","body":"2 sentences, specific and actionable"}]. No markdown.` }],
        "Return only a valid JSON array."
      );
      try { setInsights(JSON.parse(raw.replace(/```json|```/g, "").trim())); } catch { setInsights(null); }
    } catch (e) { setError(e.message); }
    finally { setLoading(false); setStage(""); }
  }

  const hasData = creators && sources && terms;
  const ct = creators ? classifyCreators(creators) : null;
  const st = sources ? classifySources(sources) : null;
  const cMax = creators ? Math.max(...creators.filter(c => c.creator).map(c => c.value), 1) : 1;
  const sMax = sources ? Math.max(...sources.filter(s => s.channel_name_slug).map(s => s.value), 1) : 1;

  return (
    <div className="root">
      {/* Ambient background blobs */}
      <div className="blob blob-1" />
      <div className="blob blob-2" />

      <div className="shell">
        {/* Header */}
        <header className="header">
          <div className="overline">All Ears · Influence Intelligence</div>
          <h1 className="display">Influence<br />Map Builder</h1>
          <p className="subtitle">Enter any brand or topic. The agent automatically detects keyword noise, refines the query, then maps who owns the spoken media conversation.</p>
        </header>

        {/* Search */}
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

        {/* Loading */}
        {loading && (
          <div className="loading-block">
            <div className="loading-dots">
              <span /><span /><span />
            </div>
            <p className="loading-stage">{stage}</p>
          </div>
        )}

        {/* Error */}
        {error && <div className="error-block">{error}</div>}

        {/* Results */}
        {hasData && !loading && (
          <div className="results">
            <div className="keyword-divider">
              <div className="divider-line" />
              <span className="keyword-pill">"{keyword}"</span>
              <div className="divider-line" />
            </div>

            <DisambigBanner info={disambig} />

            {insights && (
              <section className="insights-section">
                <div className="section-label">Strategic Insights</div>
                <div className="insights-grid">
                  {insights.map((ins, i) => <InsightCard key={i} {...ins} />)}
                </div>
              </section>
            )}

            {/* Legend */}
            <div className="legend">
              {[["mega","Mega / Dominant"],["specialist","Specialist / Regular"],["rising","Rising / Niche"]].map(([k,l]) => (
                <div key={k} className="legend-item">
                  <span className={`tier-dot dot-${k}`} />
                  <span className="legend-label">{l}</span>
                </div>
              ))}
            </div>

            {/* Tabs */}
            <div className="tabs">
              {["creators","channels","themes"].map(t => (
                <button key={t} className={`tab ${tab === t ? "tab-active" : ""}`} onClick={() => setTab(t)}>
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>

            {/* Creators */}
            {tab === "creators" && ct && (
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
              </div>
            )}

            {/* Channels */}
            {tab === "channels" && st && (
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
              </div>
            )}

            {/* Themes */}
            {tab === "themes" && terms && (
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
                    <p className="terms-note">Terms appearing distinctively alongside "{keyword}" — weighted by statistical co-occurrence, not just frequency.</p>
                  </>
                ) : (
                  <div className="empty-themes">
                    <div className="empty-icon">🔬</div>
                    <p className="empty-title">Corpus too narrow for theme analysis</p>
                    <p className="empty-body">After disambiguation filtering, the remaining episode set is too small for statistically significant co-occurrence patterns. Try a more specific phrase like "{keyword} shoes" or "{keyword} brand".</p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Empty state */}
        {!hasData && !loading && !error && (
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
