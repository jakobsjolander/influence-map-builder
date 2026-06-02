import { useState, useRef } from "react";

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

async function runAgent(keyword, onStage) {
  onStage("Running agent…");
  const res = await fetch("/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keyword }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

function Bar({ value, max }) {
  const pct = Math.max(3, Math.round((value / max) * 100));
  return <div className="bar-track"><div className="bar-fill" style={{ width: `${pct}%` }} /></div>;
}

function CreatorRow({ creator, value, tier, max }) {
  return (
    <div className={`row-item tier-${tier}`}>
      <div className="row-left"><span className={`tier-dot dot-${tier}`} /><span className="row-name">{creator}</span></div>
      <span className="row-count">{value}</span>
      <Bar value={value} max={max} />
    </div>
  );
}

function SourceRow({ slug, value, tier, max }) {
  return (
    <div className={`row-item tier-${tier}`}>
      <div className="row-left"><span className={`tier-dot dot-${tier}`} /><span className="row-name">{slugToName(slug)}</span></div>
      <span className="row-count">{value}</span>
      <Bar value={value} max={max} />
    </div>
  );
}

function InsightCard({ icon, title, body }) {
  return (
    <div className="insight-card">
      <span className="insight-icon">{icon}</span>
      <div><div className="insight-title">{title}</div><div className="insight-body">{body}</div></div>
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
    setKeyword(kw); setLoading(true); setError(null); setResult(null);
    try {
      setResult(await runAgent(kw, setStage));
      setTab("creators");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false); setStage("");
    }
  }

  const stop = new Set(["the","and","for","that","this","with","are","was","its","use","may","have","from","they","but","not","all","also","more","about","into","will","some","than","when","there","been","other","what","which","their","has"]);
  const creators = result?.creators || [];
  const sources = result?.sources || [];
  const terms = (result?.terms || []).filter(t => !stop.has(t.term) && t.term !== keyword.toLowerCase());
  const ct = classifyCreators(creators);
  const st = classifySources(sources);
  const cMax = Math.max(...creators.map(c => c.value), 1);
  const sMax = Math.max(...sources.map(s => s.value), 1);

  return (
    <div className="root">
      <div className="blob blob-1" /><div className="blob blob-2" />
      <div className="shell">
        <header className="header">
          <div className="overline">All Ears · Influence Intelligence</div>
          <h1 className="display">Influence<br />Map Builder</h1>
          <p className="subtitle">Enter any brand or topic. The agent autonomously samples mentions, detects noise, refines the query, then maps who owns the spoken media conversation.</p>
        </header>

        <div className="search-block">
          <input ref={inputRef} className="search-input" value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && run()}
            placeholder="e.g. Puma, Ozempic, electric vehicles…" />
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
                {[["mega",ct.mega,"Mega Voices"],["specialist",ct.specialist,"Specialists"],["rising",ct.rising,"Rising Voices"]]
                  .filter(([,i]) => i.length)
                  .map(([tier,items,label]) => (
                    <div key={tier} className="tier-group">
                      <div className="tier-label">
                        <span className={`tier-dot dot-${tier}`} />
                        {label} <span className="tier-count">({items.length})</span>
                      </div>
                      <div className="rows">
                        {items.map((c,i) => <CreatorRow key={i} creator={c.creator} value={c.value} tier={tier} max={cMax} />)}
                      </div>
                    </div>
                  ))}
                {creators.length === 0 && <p className="empty-msg">No creators found.</p>}
              </div>
            )}

            {tab === "channels" && (
              <div className="list-section">
                {[["dominant",st.dominant,"Dominant Channels"],["regular",st.regular,"Regular Channels"],["niche",st.niche,"Niche Channels"]]
                  .filter(([,i]) => i.length)
                  .map(([tier,items,label]) => (
                    <div key={tier} className="tier-group">
                      <div className="tier-label">
                        <span className={`tier-dot dot-${tier}`} />
                        {label} <span className="tier-count">({items.length})</span>
                      </div>
                      <div className="rows">
                        {items.map((s,i) => <SourceRow key={i} slug={s.channel_name_slug} value={s.value} tier={tier} max={sMax} />)}
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
                      {terms.map((t,i) => (
                        <span key={i} className="term-pill" style={{ opacity: Math.max(0.3, Math.min(1, t.score/300)) }}>
                          {t.term}
                        </span>
                      ))}
                    </div>
                    <p className="terms-note">Terms appearing distinctively alongside "{keyword}".</p>
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
