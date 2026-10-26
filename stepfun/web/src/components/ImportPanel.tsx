import { useRef, useState } from "react";
import { api } from "../api";
import { chunkId, chunkText } from "../lib/chunk";
import { formatMs } from "../lib/config";
import type { KnowledgeBase } from "../types";
import type { useEmbedder } from "../hooks/useEmbedder";

interface Props {
  kb: KnowledgeBase | null;
  embedder: ReturnType<typeof useEmbedder>;
  onImported: () => void;
}

interface Summary {
  chunks: number;
  chars: number;
  embedMs: number;
  totalMs: number;
  serverWriteMs: number;
}

const CHUNK_SIZE = 320;
const CHUNK_OVERLAP = 64;
const WRITE_BATCH = 32;

export function ImportPanel({ kb, embedder, onImported }: Props) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [progress, setProgress] = useState(0);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [batchSize, setBatchSize] = useState(16);
  const fileInput = useRef<HTMLInputElement>(null);

  const disabled = !kb || busy || embedder.status !== "ready";

  const collectSources = async (): Promise<Array<{ source: string; text: string }>> => {
    const sources: Array<{ source: string; text: string }> = [];
    if (text.trim()) sources.push({ source: "粘贴文本", text });
    for (const file of files) sources.push({ source: file.name, text: await file.text() });
    return sources;
  };

  const importSources = async (sources: Array<{ source: string; text: string }>) => {
    if (!kb) return;
    const started = performance.now();
    setError(null);
    setSummary(null);
    setBusy(true);

    try {
      setStage("切分文本");
      setProgress(0);
      const chunks = sources.flatMap(({ source, text }) =>
        chunkText(text, { maxChars: CHUNK_SIZE, overlap: CHUNK_OVERLAP }).map((chunk, index) => ({
          id: chunkId(source, index, chunk),
          text: chunk,
          source,
          chunk: index,
        })),
      );

      if (chunks.length === 0) throw new Error("没有可导入的文本内容");

      setStage(`本地向量化（0/${chunks.length}）`);
      const embedded = await embedder.embed(
        chunks.map((chunk) => chunk.text),
        {
          batchSize,
          onProgress: (done, total) => {
            setStage(`本地向量化（${done}/${total}）`);
            setProgress(done / total);
          },
        },
      );
      const embedMs = embedded.elapsedMs;

      setStage("写入 seekdb");
      let serverWriteMs = 0;
      for (let offset = 0; offset < chunks.length; offset += WRITE_BATCH) {
        const slice = chunks.slice(offset, offset + WRITE_BATCH);
        const docs = slice.map((chunk, index) => ({
          id: chunk.id,
          text: chunk.text,
          source: chunk.source,
          chunk: chunk.chunk,
          embedding: Array.from(embedded.vectors[offset + index]),
        }));
        const result = await api.addDocs(kb.id, docs);
        serverWriteMs += result.ms;
        setProgress(Math.min(1, (offset + slice.length) / chunks.length));
      }

      const totalMs = performance.now() - started;
      setSummary({
        chunks: chunks.length,
        chars: chunks.reduce((sum, chunk) => sum + chunk.text.length, 0),
        embedMs,
        totalMs,
        serverWriteMs,
      });
      setText("");
      setFiles([]);
      if (fileInput.current) fileInput.current.value = "";
      onImported();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      setProgress(0);
      setStage("");
    }
  };

  const loadSample = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/eval/corpus.jsonl");
      if (!response.ok) throw new Error("示例语料不可用");
      const rows = (await response.text())
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { id: string; text: string; source: string });
      await importSources(rows.map((row) => ({ source: row.source || row.id, text: row.text })));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <header className="panel__header">
        <div>
          <h2>导入语料</h2>
          <p>文本在浏览器内切分并向量化，向量与原文写入 seekdb，导入后可立即检索。</p>
        </div>
        <button className="ghost" onClick={() => void loadSample()} disabled={disabled}>
          导入示例语料
        </button>
      </header>

      <div className="field">
        <label>粘贴文本</label>
        <textarea
          value={text}
          rows={7}
          placeholder="粘贴需要入库的文本，支持多段落；导入会按 320 字切块并保留 64 字重叠。"
          onChange={(event) => setText(event.target.value)}
        />
      </div>

      <div className="field">
        <label>或选择本地文件（.txt / .md / .json）</label>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept=".txt,.md,.markdown,.json,.csv"
          onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
        />
        {files.length > 0 && <span className="hint">已选择 {files.length} 个文件</span>}
      </div>

      <div className="actions">
        <label className="select">
          向量化批大小
          <select value={batchSize} onChange={(event) => setBatchSize(Number(event.target.value))}>
            {[1, 8, 16, 32].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <button
          className="primary"
          disabled={disabled}
          onClick={() => {
            void (async () => {
              const sources = await collectSources();
              if (sources.length === 0) {
                setError("请先粘贴文本或选择文件");
                return;
              }
              await importSources(sources);
            })();
          }}
        >
          本地向量化并写入 seekdb
        </button>
        <span className="hint">
          {kb ? `目标知识库：${kb.name}（${kb.dim} 维）` : "请先在左侧创建知识库"}
        </span>
      </div>

      {busy && (
        <div className="progress">
          <div className="progress__bar" style={{ width: `${Math.round(progress * 100)}%` }} />
          <span className="progress__label">{stage}</span>
        </div>
      )}

      {error && <p className="notice notice--error">{error}</p>}

      {summary && (
        <div className="summary">
          <div className="summary__item">
            <span>片段数</span>
            <strong>{summary.chunks}</strong>
          </div>
          <div className="summary__item">
            <span>字符数</span>
            <strong>{summary.chars.toLocaleString()}</strong>
          </div>
          <div className="summary__item">
            <span>向量化</span>
            <strong>{formatMs(summary.embedMs)}</strong>
          </div>
          <div className="summary__item">
            <span>seekdb 写入</span>
            <strong>{formatMs(summary.serverWriteMs)}</strong>
          </div>
          <div className="summary__item">
            <span>端到端</span>
            <strong>{formatMs(summary.totalMs)}</strong>
          </div>
          <div className="summary__item">
            <span>批大小</span>
            <strong>{batchSize}</strong>
          </div>
          <div className="summary__item">
            <span>向量化吞吐</span>
            <strong>{Math.round(summary.chars / (summary.embedMs / 1000)).toLocaleString()} 字/秒</strong>
          </div>
        </div>
      )}
    </section>
  );
}
