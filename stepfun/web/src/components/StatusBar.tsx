import type { DeviceKind, EmbedderInfo, Precision } from "../types";
import { PRECISION_OPTIONS, formatBytes, formatMs } from "../lib/config";
import type { EmbedderStatus } from "../hooks/useEmbedder";

interface Props {
  status: EmbedderStatus;
  info: EmbedderInfo | null;
  error: string | null;
  download: { file?: string; ratio: number } | null;
  detected: { device: DeviceKind; reason?: string } | null;
  precision: Precision | "auto";
  onPrecisionChange: (value: Precision | "auto") => void;
  onRetry: () => void;
}

export function StatusBar({
  status,
  info,
  error,
  download,
  detected,
  precision,
  onPrecisionChange,
  onRetry,
}: Props) {
  const device = info?.device ?? detected?.device;
  const degraded = detected?.device === "wasm" && detected.reason;

  return (
    <section className="statusbar">
      <div className="statusbar__main">
        <span className={`badge badge--${device === "webgpu" ? "gpu" : "cpu"}`}>
          <span className="badge__dot" />
          {status === "loading" && !info
            ? "模型加载中"
            : device === "webgpu"
              ? "WebGPU"
              : "WASM"}
        </span>
        <span className="statusbar__model">{info?.model ?? "—"}</span>
        {info && <span className="chip">{info.dtype.toUpperCase()}</span>}
        {info && <span className="chip">{info.dim} 维</span>}

        <span className="statusbar__spacer" />

        <label className="select">
          精度方案
          <select
            value={precision}
            onChange={(event) => onPrecisionChange(event.target.value as Precision | "auto")}
          >
            {PRECISION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <button className="ghost" onClick={onRetry} disabled={status === "loading"}>
          重新加载模型
        </button>
      </div>

      <div className="statusbar__metrics">
        <Metric label="模型体积" value={formatBytes(info?.modelBytes ?? 0)} />
        <Metric label="加载耗时" value={formatMs(info?.loadMs ?? 0)} />
        <Metric label="预热耗时" value={formatMs(info?.warmupMs ?? 0)} />
        <Metric label="推理位置" value="浏览器本地" />
      </div>

      {status === "loading" && (
        <p className="notice notice--info">
          正在加载模型{download?.file ? `：${download.file}` : ""}
          {download ? `（${Math.min(100, Math.max(0, Math.round(download.ratio <= 1 ? download.ratio * 100 : download.ratio)))}%）` : ""}
          ，首次运行需要下载权重，之后走浏览器缓存。
        </p>
      )}
      {info?.fallbackReason && status === "ready" && (
        <p className="notice notice--warn">{info.fallbackReason}</p>
      )}
      {degraded && status !== "error" && !info?.fallbackReason && (
        <p className="notice notice--warn">
          已自动降级到 WASM 后端：{detected?.reason}。核心流程仍然可用，检索质量不受影响。
        </p>
      )}
      {error && (
        <p className="notice notice--error">
          模型加载失败：{error}
          <button className="link" onClick={onRetry}>
            重试
          </button>
        </p>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span className="metric__label">{label}</span>
      <span className="metric__value">{value}</span>
    </div>
  );
}
