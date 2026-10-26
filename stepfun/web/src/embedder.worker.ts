/// <reference lib="webworker" />
/**
 * Embedding worker.
 *
 * All inference happens here, inside the user's browser, through
 * Transformers.js on top of ONNX Runtime Web (WebGPU or WASM). No text or
 * vector is ever sent to a remote inference service.
 */
import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

type Device = "webgpu" | "wasm";
type Dtype = "fp32" | "q8" | "fp16";

let extractor: FeatureExtractionPipeline | null = null;
let ready = false;

function post(message: unknown, transfer: Transferable[] = []) {
  ctx.postMessage(message, transfer);
}

async function init(message: {
  model: string;
  device: Device;
  dtype: Dtype;
  remoteHost?: string;
  threads?: number;
  preferLocal?: boolean;
  note?: string;
}) {
  const started = performance.now();
  if (message.remoteHost) env.remoteHost = message.remoteHost;
  env.useBrowserCache = true;
  if (message.preferLocal) {
    // Weights were pre-fetched by `npm run fetch-model`; keep inference fully
    // offline by refusing remote downloads.
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.localModelPath = new URL("/models/", ctx.location.origin).href;
  } else {
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
  }

  const files = new Map<string, number>();
  const wasm = (env as any).backends?.onnx?.wasm;
  if (wasm) {
    wasm.numThreads = message.threads ?? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2));
  }

  const options: any = {
    device: message.device,
    dtype: message.dtype,
    progress_callback: (progress: any) => {
      if (progress?.status === "progress" && progress.total) {
        files.set(progress.file ?? progress.name ?? "model", progress.total);
        post({ type: "status", phase: "download", file: progress.file, ratio: progress.progress ?? 0 });
      } else if (progress?.status === "ready") {
        post({ type: "status", phase: "ready" });
      }
    },
  };

  const createPipeline = pipeline as any;
  let effectiveDevice: Device = message.device;
  let effectiveDtype: Dtype = message.dtype;
  let fallbackReason: string | undefined;
  let firstError = "";

  try {
    extractor = (await createPipeline("feature-extraction", message.model, options)) as FeatureExtractionPipeline;
  } catch (error) {
    firstError = error instanceof Error ? error.message : String(error);
  }

  if (!extractor && message.preferLocal) {
    // Local weights are incomplete: allow remote download instead of failing.
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    try {
      extractor = (await createPipeline("feature-extraction", message.model, options)) as FeatureExtractionPipeline;
    } catch (error) {
      firstError = error instanceof Error ? error.message : String(error);
    }
  }

  if (!extractor && message.device === "webgpu") {
    // A usable adapter can still fail when the session is created (shader
    // compilation, device memory pressure). Retry on WASM so the flow survives.
    fallbackReason = `WebGPU 会话创建失败，已自动降级 WASM：${firstError}`;
    effectiveDevice = "wasm";
    effectiveDtype = "q8";
    try {
      extractor = (await createPipeline("feature-extraction", message.model, {
        ...options,
        device: effectiveDevice,
        dtype: effectiveDtype,
      })) as FeatureExtractionPipeline;
    } catch (error) {
      firstError = error instanceof Error ? error.message : String(error);
    }
  }

  if (!extractor) {
    post({
      type: "error",
      message: firstError,
    });
    return;
  }

  const loadMs = performance.now() - started;

  // Warmup compiles WebGPU shaders / primes the WASM heap so the first user
  // request is not penalised by one-off initialisation.
  const warmStarted = performance.now();
  await extractor(["warmup"], { pooling: "cls", normalize: true });
  const warmupMs = performance.now() - warmStarted;
  ready = true;

  const modelBytes = [...files.values()].reduce((sum, value) => sum + value, 0);
  const probe = await extractor(["dimension probe"], { pooling: "cls", normalize: true });
  const dim = (probe as any).dims?.at(-1) ?? 0;

  post({
    type: "ready",
    info: {
      model: message.model,
      device: effectiveDevice,
      dtype: effectiveDtype,
      loadMs,
      warmupMs,
      modelBytes,
      dim,
      fallbackReason: message.note ?? fallbackReason,
    },
  });
}

async function embed(message: { jobId: number; texts: string[]; batchSize: number }) {
  if (!extractor || !ready) {
    post({ type: "embed-error", jobId: message.jobId, message: "embedder is not ready" });
    return;
  }
  const { jobId, texts, batchSize } = message;
  const vectors: Float32Array[] = [];
  const batchTimes: number[] = [];
  const started = performance.now();

  for (let offset = 0; offset < texts.length; offset += batchSize) {
    const batch = texts.slice(offset, offset + batchSize);
    const batchStarted = performance.now();
    try {
      const output: any = await extractor(batch, { pooling: "cls", normalize: true });
      const rows: number[][] = output.tolist();
      const dim = rows[0]?.length ?? 0;
      for (const row of rows) vectors.push(Float32Array.from(row));
      batchTimes.push(performance.now() - batchStarted);
      post({
        type: "embed-progress",
        jobId,
        done: Math.min(offset + batch.length, texts.length),
        total: texts.length,
        dim,
      });
    } catch (error) {
      post({
        type: "embed-error",
        jobId,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }

  const elapsed = performance.now() - started;
  post(
    { type: "embed-done", jobId, vectors, elapsedMs: elapsed, batchTimes },
    vectors.map((vector) => vector.buffer),
  );
}

ctx.onmessage = async (event: MessageEvent) => {
  const message = event.data;
  try {
    if (message?.type === "init") await init(message);
    else if (message?.type === "embed") await embed(message);
  } catch (error) {
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
