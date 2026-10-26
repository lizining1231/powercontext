import { useState } from "react";
import { api } from "../api";
import { formatMs } from "../lib/config";
import type { useEmbedder } from "../hooks/useEmbedder";

interface CorpusRow {
  id: string;
  text: string;
  source: string;
}

interface QueryRow {
  id: string;
  query: string;
  relevant: string[];
}

interface QueryResult {
  id: string;
  query: string;
  recall5: number;
  recall10: number;
  ndcg10: number;
  mrr10: number;
  embedMs: number;
  dbMs: number;
  retrieved: string[];
  relevant: string[];
}

interface Report {
  dtype: string;
  device: string;
  corpusSize: number;
  queryCount: number;
  recall5: number;
  recall10: number;
  ndcg10: number;
  mrr10: number;
  avgEmbedMs: number;
  avgDbMs: number;
  importMs: number;
  rows: QueryResult[];
}

async function loadJsonl<T>(url: string): Promise<T[]> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`无法加载 ${url}`);
  return (await response.text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function recallAt(retrieved: string[], relevant: string[], k: number): number {
  if (relevant.length === 0) return 0;
  const hit = new Set(retrieved.slice(0, k));
  return relevant.filter((id) => hit.has(id)).length / relevant.length;
}

function ndcgAt(retrieved: string[], relevant: string[], k: number): number {
  const relevantSet = new Set(relevant);
  let dcg = 0;
  for (let i = 0; i < Math.min(k, retrieved.length); i += 1) {
    if (relevantSet.has(retrieved[i])) dcg += 1 / Math.log2(i + 2);
  }
  let idcg = 0;
  for (let i = 0; i < Math.min(k, relevant.length); i += 1) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

function mrrAt(retrieved: string[], relevant: string[], k: number): number {
  const relevantSet = new Set(relevant);
  for (let i = 0; i < Math.min(k, retrieved.length); i += 1) {
    if (relevantSet.has(retrieved[i])) return 1 / (i + 1);
  }
  return 0;
}

const average = (values: number[]) =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

export function EvalPanel({
  embedder,
  onFinished,
}: {
  embedder: ReturnType<typeof useEmbedder>;
  onFinished: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ready = embedder.status === "ready" && embedder.info;

  const run = async () => {
    if (!embedder.info) return;
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const [corpus, queries] = await Promise.all([
        loadJsonl<CorpusRow>("/eval/corpus.jsonl"),
        loadJsonl<QueryRow>("/eval/queries.jsonl"),
      ]);

      setStage("创建评测知识库");
      const kb = await api.createKnowledgeBase(
        `评测 ${embedder.info.dtype}-${new Date().toLocaleTimeString()}`,
        embedder.info.dim,
        embedder.info.model,
      );
      onFinished();

      setStage(`向量化语料（0/${corpus.length}）`);
      const importStarted = performance.now();
      const embedded = await embedder.embed(
        corpus.map((row) => row.text),
        {
          batchSize: 16,
          onProgress: (done, total) => setStage(`向量化语料（${done}/${total}）`),
        },
      );

      setStage("写入 seekdb");
      const batch = 32;
      for (let offset = 0; offset < corpus.length; offset += batch) {
        const slice = corpus.slice(offset, offset + batch);
        await api.addDocs(
          kb.id,
          slice.map((row, index) => ({
            id: row.id,
            text: row.text,
            source: row.id,
            chunk: 0,
            embedding: Array.from(embedded.vectors[offset + index]),
          })),
        );
      }
      const importMs = performance.now() - importStarted;

      const rows: QueryResult[] = [];
      for (let i = 0; i < queries.length; i += 1) {
        const query = queries[i];
        setStage(`评测查询（${i + 1}/${queries.length}）`);
        const queryVector = await embedder.embed([query.query], { batchSize: 1 });
        const embedMs = queryVector.elapsedMs;
        const response = await api.search(kb.id, {
          text: query.query,
          embedding: Array.from(queryVector.vectors[0]),
          k: 10,
          mode: "hybrid",
        });
        const retrieved = response.hits.map((hit) => String(hit.meta.source ?? hit.id));
        rows.push({
          id: query.id,
          query: query.query,
          recall5: recallAt(retrieved, query.relevant, 5),
          recall10: recallAt(retrieved, query.relevant, 10),
          ndcg10: ndcgAt(retrieved, query.relevant, 10),
          mrr10: mrrAt(retrieved, query.relevant, 10),
          embedMs,
          dbMs: response.ms,
          retrieved,
          relevant: query.relevant,
        });
      }

      setReport({
        dtype: embedder.info.dtype,
        device: embedder.info.device,
        corpusSize: corpus.length,
        queryCount: queries.length,
        recall5: average(rows.map((row) => row.recall5)),
        recall10: average(rows.map((row) => row.recall10)),
        ndcg10: average(rows.map((row) => row.ndcg10)),
        mrr10: average(rows.map((row) => row.mrr10)),
        avgEmbedMs: average(rows.map((row) => row.embedMs)),
        avgDbMs: average(rows.map((row) => row.dbMs)),
        importMs,
        rows,
      });
      onFinished();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      setStage("");
    }
  };

  const exportReport = () => {
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `eval-${report.dtype}-${report.device}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="panel">
      <header className="panel__header">
        <div>
          <h2>检索质量评测</h2>
          <p>在相同语料与查询集上量化当前精度方案的 Recall / nDCG，用于量化前后对比。</p>
        </div>
        <div className="actions">
          <button className="primary" onClick={() => void run()} disabled={!ready || busy}>
            {busy ? "评测中…" : "运行评测"}
          </button>
          <button className="ghost" onClick={exportReport} disabled={!report}>
            导出 JSON
          </button>
        </div>
      </header>

      {busy && <p className="notice notice--info">{stage}</p>}
      {error && <p className="notice notice--error">{error}</p>}

      {report && (
        <>
          <div className="summary">
            <div className="summary__item">
              <span>配置</span>
              <strong>
                {report.dtype.toUpperCase()} · {report.device === "webgpu" ? "WebGPU" : "WASM"}
              </strong>
            </div>
            <div className="summary__item">
              <span>语料 / 查询</span>
              <strong>
                {report.corpusSize} / {report.queryCount}
              </strong>
            </div>
            <div className="summary__item">
              <span>Recall@5</span>
              <strong>{report.recall5.toFixed(3)}</strong>
            </div>
            <div className="summary__item">
              <span>Recall@10</span>
              <strong>{report.recall10.toFixed(3)}</strong>
            </div>
            <div className="summary__item">
              <span>nDCG@10</span>
              <strong>{report.ndcg10.toFixed(3)}</strong>
            </div>
            <div className="summary__item">
              <span>MRR@10</span>
              <strong>{report.mrr10.toFixed(3)}</strong>
            </div>
            <div className="summary__item">
              <span>查询向量化</span>
              <strong>{formatMs(report.avgEmbedMs)}</strong>
            </div>
            <div className="summary__item">
              <span>seekdb 检索</span>
              <strong>{formatMs(report.avgDbMs)}</strong>
            </div>
            <div className="summary__item">
              <span>语料导入</span>
              <strong>{formatMs(report.importMs)}</strong>
            </div>
          </div>

          <table className="table">
            <thead>
              <tr>
                <th>查询</th>
                <th>Recall@5</th>
                <th>Recall@10</th>
                <th>nDCG@10</th>
                <th>MRR@10</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row) => (
                <tr key={row.id}>
                  <td title={row.query}>{row.query}</td>
                  <td>{row.recall5.toFixed(2)}</td>
                  <td>{row.recall10.toFixed(2)}</td>
                  <td>{row.ndcg10.toFixed(2)}</td>
                  <td>{row.mrr10.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
