import { useMemo, useState } from "react";
import { api } from "../api";
import { formatMs } from "../lib/config";
import type { KnowledgeBase, SearchHit } from "../types";
import type { useEmbedder } from "../hooks/useEmbedder";

interface Props {
  kb: KnowledgeBase | null;
  embedder: ReturnType<typeof useEmbedder>;
}

type Mode = "hybrid" | "vector" | "fulltext";

const MODES: Array<{ value: Mode; label: string; hint: string }> = [
  { value: "hybrid", label: "混合检索", hint: "向量 + 全文，seekdb 内 RRF 融合" },
  { value: "vector", label: "仅向量", hint: "HNSW 余弦相似度" },
  { value: "fulltext", label: "仅全文", hint: "MATCH AGAINST 关键词" },
];

interface Timings {
  embedMs: number;
  dbMs: number;
  totalMs: number;
}

export function SearchPanel({ kb, embedder }: Props) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>("hybrid");
  const [topK, setTopK] = useState(6);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [timings, setTimings] = useState<Timings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastQuery, setLastQuery] = useState("");

  const disabled = !kb || busy || embedder.status !== "ready" || !query.trim();

  const tokens = useMemo(() => {
    const parts = lastQuery
      .split(/[\s，。、；：？！,.;:?!()（）\[\]【】"'“”]+/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 2);
    const grams = new Set<string>(parts);
    for (const part of parts) {
      if (part.length > 4) {
        for (let i = 0; i + 3 <= part.length; i += 2) grams.add(part.slice(i, i + 3));
      }
    }
    return [...grams].sort((a, b) => b.length - a.length).slice(0, 12);
  }, [lastQuery]);

  const run = async () => {
    if (!kb || !query.trim()) return;
    setBusy(true);
    setError(null);
    const started = performance.now();
    try {
      const embedded = await embedder.embed([query], { batchSize: 1 });
      const embedMs = embedded.elapsedMs;
      const response = await api.search(kb.id, {
        text: query,
        embedding: Array.from(embedded.vectors[0]),
        k: topK,
        mode,
      });
      setHits(response.hits);
      setLastQuery(query);
      setTimings({ embedMs, dbMs: response.ms, totalMs: performance.now() - started });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setHits([]);
      setTimings(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <header className="panel__header">
        <div>
          <h2>检索</h2>
          <p>查询向量同样在浏览器内生成，随后由 seekdb 完成召回与融合排序。</p>
        </div>
        <span className="chip">{kb ? `${kb.docCount} 个片段` : "未选择知识库"}</span>
      </header>

      <div className="searchbar">
        <input
          value={query}
          placeholder="输入问题，例如：如何在浏览器里跑向量模型？"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void run();
          }}
        />
        <button className="primary" onClick={() => void run()} disabled={disabled}>
          {busy ? "检索中…" : "检索"}
        </button>
      </div>

      <div className="searchbar__options">
        {MODES.map((item) => (
          <label key={item.value} className={mode === item.value ? "radio is-active" : "radio"}>
            <input
              type="radio"
              name="mode"
              checked={mode === item.value}
              onChange={() => setMode(item.value)}
            />
            <span>{item.label}</span>
            <em>{item.hint}</em>
          </label>
        ))}
        <label className="select">
          Top-K
          <select value={topK} onChange={(event) => setTopK(Number(event.target.value))}>
            {[3, 5, 6, 10, 20].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </div>

      {timings && (
        <div className="timings">
          <span>查询向量化 {formatMs(timings.embedMs)}</span>
          <span>seekdb 检索 {formatMs(timings.dbMs)}</span>
          <span>端到端 {formatMs(timings.totalMs)}</span>
        </div>
      )}

      {error && <p className="notice notice--error">{error}</p>}

      <ol className="results">
        {hits.map((hit) => (
          <li key={hit.id} className="result">
            <div className="result__head">
              <span className="result__rank">#{hit.rank}</span>
              <span className="result__source">{String(hit.meta.source ?? "未知来源")}</span>
              <span className="result__chunk">片段 {String(hit.meta.chunk ?? "-")}</span>
              {hit.distance !== null && (
                <span className="result__distance">向量距离 {hit.distance.toFixed(4)}</span>
              )}
            </div>
            <p
              className="result__text"
              dangerouslySetInnerHTML={{ __html: highlight(hit.text, tokens) }}
            />
          </li>
        ))}
        {!busy && hits.length === 0 && lastQuery && <li className="results__empty">没有命中结果</li>}
      </ol>
    </section>
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function highlight(text: string, tokens: string[]): string {
  let html = escapeHtml(text);
  for (const token of tokens) {
    if (!token) continue;
    const safe = escapeHtml(token);
    html = html.split(safe).join(`<mark>${safe}</mark>`);
  }
  return html;
}
