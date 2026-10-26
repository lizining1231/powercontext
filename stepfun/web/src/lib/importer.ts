import { api } from "../api";
import { chunkId, chunkText } from "./chunk";

export interface ImportSummary {
  chunks: number;
  chars: number;
  embedMs: number;
  serverWriteMs: number;
  totalMs: number;
  batchSize: number;
}

interface Embedder {
  (texts: string[], options: { batchSize: number; onProgress?: (done: number, total: number) => void }): Promise<{
    vectors: Float32Array[];
    elapsedMs: number;
  }>;
}

export interface ImportParams {
  kbId: string;
  sources: Array<{ source: string; text: string }>;
  embed: Embedder;
  batchSize?: number;
  chunkSize?: number;
  overlap?: number;
  writeBatch?: number;
  onStage?: (stage: string, progress: number) => void;
}

/**
 * Chunks the given sources, embeds them in the browser, then writes the
 * resulting vectors to seekdb in batches. Shared by the import panel and the
 * first-run demo so both follow exactly one code path.
 */
export async function importTexts({
  kbId,
  sources,
  embed,
  batchSize = 16,
  chunkSize = 320,
  overlap = 64,
  writeBatch = 32,
  onStage,
}: ImportParams): Promise<ImportSummary> {
  const started = performance.now();
  onStage?.("切分文本", 0);

  const chunks = sources.flatMap(({ source, text }) =>
    chunkText(text, { maxChars: chunkSize, overlap }).map((chunk, index) => ({
      id: chunkId(source, index, chunk),
      text: chunk,
      source,
      chunk: index,
    })),
  );
  if (chunks.length === 0) throw new Error("没有可导入的文本内容");

  onStage?.(`本地向量化（0/${chunks.length}）`, 0);
  const embedded = await embed(
    chunks.map((chunk) => chunk.text),
    {
      batchSize,
      onProgress: (done, total) => onStage?.(`本地向量化（${done}/${total}）`, done / total),
    },
  );

  onStage?.("写入 seekdb", 0);
  let serverWriteMs = 0;
  for (let offset = 0; offset < chunks.length; offset += writeBatch) {
    const slice = chunks.slice(offset, offset + writeBatch);
    const result = await api.addDocs(
      kbId,
      slice.map((chunk, index) => ({
        id: chunk.id,
        text: chunk.text,
        source: chunk.source,
        chunk: chunk.chunk,
        embedding: Array.from(embedded.vectors[offset + index]),
      })),
    );
    serverWriteMs += result.ms;
    onStage?.("写入 seekdb", Math.min(1, (offset + slice.length) / chunks.length));
  }

  return {
    chunks: chunks.length,
    chars: chunks.reduce((sum, chunk) => sum + chunk.text.length, 0),
    embedMs: embedded.elapsedMs,
    serverWriteMs,
    totalMs: performance.now() - started,
    batchSize,
  };
}
