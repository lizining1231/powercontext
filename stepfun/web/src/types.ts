export type DeviceKind = "webgpu" | "wasm";
export type Precision = "fp32" | "q8" | "fp16";

export interface EmbedderInfo {
  model: string;
  device: DeviceKind;
  dtype: Precision;
  loadMs: number;
  warmupMs: number;
  modelBytes: number;
  dim: number;
  fallbackReason?: string;
}

export interface KnowledgeBase {
  id: string;
  name: string;
  dim: number;
  docCount: number;
  model: string;
  createdAt: string;
}

export interface Chunk {
  id: string;
  text: string;
  source: string;
  chunk: number;
  embedding: number[];
}

export interface SearchHit {
  id: string;
  text: string;
  meta: Record<string, unknown>;
  distance: number | null;
  rank: number;
}

export interface SearchResponse {
  mode: "hybrid" | "vector" | "fulltext";
  ms: number;
  hits: SearchHit[];
}

export interface ImportStage {
  chunking: number;
  embedding: number;
  writing: number;
  total: number;
}
