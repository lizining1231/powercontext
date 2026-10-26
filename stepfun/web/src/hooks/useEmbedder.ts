import { useCallback, useEffect, useRef, useState } from "react";
import type { DeviceKind, EmbedderInfo, Precision } from "../types";

export type EmbedderStatus = "idle" | "loading" | "ready" | "error";

interface EmbedResult {
  vectors: Float32Array[];
  elapsedMs: number;
  batchTimes: number[];
}

interface InitWaiter {
  resolve: (info: EmbedderInfo) => void;
  reject: (error: Error) => void;
}

interface Job {
  resolve: (result: EmbedResult) => void;
  reject: (error: Error) => void;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Detects whether WebGPU is usable and reports why fallback happened, so the
 * UI can state the active backend explicitly instead of silently degrading.
 */
export async function detectDevice(): Promise<{ device: DeviceKind; reason?: string }> {
  // Test hook: ?backend=wasm simulates a browser without WebGPU so the
  // automatic downgrade path and its UI notice can be verified on any machine.
  const forced = new URLSearchParams(window.location.search).get("backend");
  if (forced === "wasm") return { device: "wasm", reason: "URL 参数 backend=wasm 强制降级" };
  if (forced === "webgpu") return { device: "webgpu" };

  const gpu = (navigator as any).gpu;
  if (!gpu) return { device: "wasm", reason: "navigator.gpu 不存在" };
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { device: "wasm", reason: "未获取到 GPU 适配器" };
    return { device: "webgpu" };
  } catch (error) {
    return { device: "wasm", reason: error instanceof Error ? error.message : "WebGPU 初始化失败" };
  }
}

export function useEmbedder() {
  const workerRef = useRef<Worker | null>(null);
  const jobs = useRef(new Map<number, Job>());
  const initWaiter = useRef<InitWaiter | null>(null);
  const nextJobId = useRef(1);

  const [status, setStatus] = useState<EmbedderStatus>("idle");
  const [info, setInfo] = useState<EmbedderInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [download, setDownload] = useState<{ file?: string; ratio: number } | null>(null);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  const ensureWorker = useCallback(() => {
    if (workerRef.current) return workerRef.current;

    const worker = new Worker(new URL("../embedder.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent) => {
      const message = event.data;
      switch (message.type) {
        case "status":
          setDownload({ file: message.file, ratio: message.ratio ?? 0 });
          break;
        case "ready": {
          setDownload(null);
          setInfo(message.info as EmbedderInfo);
          setStatus("ready");
          initWaiter.current?.resolve(message.info as EmbedderInfo);
          initWaiter.current = null;
          break;
        }
        case "error": {
          const failure = new Error(message.message);
          setError(message.message);
          setStatus("error");
          initWaiter.current?.reject(failure);
          initWaiter.current = null;
          break;
        }
        case "embed-progress":
          jobs.current.get(message.jobId)?.onProgress?.(message.done, message.total);
          break;
        case "embed-done": {
          const job = jobs.current.get(message.jobId);
          jobs.current.delete(message.jobId);
          job?.resolve({
            vectors: message.vectors as Float32Array[],
            elapsedMs: message.elapsedMs,
            batchTimes: message.batchTimes,
          });
          break;
        }
        case "embed-error": {
          const job = jobs.current.get(message.jobId);
          jobs.current.delete(message.jobId);
          job?.reject(new Error(message.message));
          break;
        }
        default:
          break;
      }
    };
    workerRef.current = worker;
    return worker;
  }, []);

  const init = useCallback(
    (options: { model: string; device: DeviceKind; dtype: Precision; remoteHost?: string }) =>
      new Promise<EmbedderInfo>((resolve, reject) => {
        const worker = ensureWorker();
        initWaiter.current = { resolve, reject };
        setStatus("loading");
        setError(null);
        setInfo(null);
        setDownload(null);
        worker.postMessage({
          type: "init",
          model: options.model,
          device: options.device,
          dtype: options.dtype,
          remoteHost: options.remoteHost,
        });
      }),
    [ensureWorker],
  );

  const embed = useCallback(
    (texts: string[], options: { batchSize: number; onProgress?: (done: number, total: number) => void }) =>
      new Promise<EmbedResult>((resolve, reject) => {
        const worker = ensureWorker();
        const jobId = nextJobId.current++;
        jobs.current.set(jobId, { resolve, reject, onProgress: options.onProgress });
        worker.postMessage({ type: "embed", jobId, texts, batchSize: options.batchSize });
      }),
    [ensureWorker],
  );

  return { status, info, error, download, init, embed };
}
