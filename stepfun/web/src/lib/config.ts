import type { DeviceKind, Precision } from "../types";

export const DEFAULT_MODEL = (import.meta.env.VITE_EMBEDDING_MODEL as string) || "Xenova/bge-small-zh-v1.5";
export const HF_ENDPOINT = (import.meta.env.VITE_HF_ENDPOINT as string) || undefined;

export interface PrecisionOption {
  value: Precision | "auto";
  label: string;
  device: DeviceKind;
  detail: string;
}

export const PRECISION_OPTIONS: PrecisionOption[] = [
  {
    value: "auto",
    label: "自动",
    device: "webgpu",
    detail: "有 WebGPU 用 FP16，否则 INT8 + WASM",
  },
  { value: "fp16", label: "FP16 + WebGPU", device: "webgpu", detail: "半精度，GPU 推理" },
  { value: "q8", label: "INT8 + WASM", device: "wasm", detail: "动态量化，CPU 推理" },
  { value: "fp32", label: "FP32 基线", device: "wasm", detail: "未量化基线，用于对比" },
];

export function resolvePrecision(
  choice: Precision | "auto",
  detected: DeviceKind,
): { dtype: Precision; device: DeviceKind; note?: string } {
  if (choice === "auto") {
    return detected === "webgpu"
      ? { dtype: "fp16", device: "webgpu" }
      : { dtype: "q8", device: "wasm", note: "未检测到可用 WebGPU，自动降级到 WASM" };
  }
  if (choice === "fp16") {
    return detected === "webgpu"
      ? { dtype: "fp16", device: "webgpu" }
      : { dtype: "q8", device: "wasm", note: "FP16 需要 WebGPU，已降级为 INT8 + WASM" };
  }
  return { dtype: choice, device: "wasm" };
}

export function formatBytes(bytes: number): string {
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`;
}
