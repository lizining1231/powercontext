import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { DEFAULT_MODEL, HF_ENDPOINT, resolvePrecision } from "./lib/config";
import { importTexts } from "./lib/importer";
import { loadCorpus } from "./lib/corpus";
import { detectDevice, useEmbedder } from "./hooks/useEmbedder";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { ImportPanel } from "./components/ImportPanel";
import { SearchPanel } from "./components/SearchPanel";
import { EvalPanel } from "./components/EvalPanel";
import type { DeviceKind, KnowledgeBase, Precision } from "./types";

type Tab = "import" | "search" | "eval";

const TABS: Array<{ value: Tab; label: string }> = [
  { value: "import", label: "导入" },
  { value: "search", label: "检索" },
  { value: "eval", label: "质量评测" },
];

export default function App() {
  const embedder = useEmbedder();
  const [detected, setDetected] = useState<{ device: DeviceKind; reason?: string } | null>(null);
  const [precision, setPrecision] = useState<Precision | "auto">("auto");
  const [reloadToken, setReloadToken] = useState(0);
  const [items, setItems] = useState<KnowledgeBase[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("import");
  const [seekdbPath, setSeekdbPath] = useState<string | undefined>(undefined);
  const [bootError, setBootError] = useState<string | null>(null);
  const [demo, setDemo] = useState<{ stage: string; progress: number } | null>(null);
  const [demoError, setDemoError] = useState<string | null>(null);
  const [demoQuery, setDemoQuery] = useState<string | null>(null);
  const demoStarted = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const response = await api.listKnowledgeBases();
      setItems(response.items);
      setActiveId((current) =>
        current && response.items.some((item) => item.id === current)
          ? current
          : (response.items[0]?.id ?? null),
      );
    } catch (error) {
      setBootError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void refresh();
    api
      .health()
      .then((health) => setSeekdbPath(`${health.seekdb.path}（${health.seekdb.mode}）`))
      .catch(() => undefined);
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const detection = await detectDevice();
      if (cancelled) return;
      setDetected(detection);
      const resolved = resolvePrecision(precision, detection.device);
      try {
        await embedder.init({
          model: DEFAULT_MODEL,
          device: resolved.device,
          dtype: resolved.dtype,
          remoteHost: HF_ENDPOINT,
        });
      } catch {
        /* surfaced through embedder.error */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [precision, reloadToken]);

  // A fresh clone has no data. Seed one demo knowledge base automatically so the
  // first screen already shows the full import -> embed -> retrieve flow.
  useEffect(() => {
    if (demoStarted.current) return;
    if (embedder.status !== "ready" || !embedder.info) return;
    if (items.length !== 0) return;
    demoStarted.current = true;
    void (async () => {
      try {
        setDemo({ stage: "创建示例知识库", progress: 0 });
        const kb = await api.createKnowledgeBase("示例知识库", embedder.info!.dim, DEFAULT_MODEL);
        await refresh();
        setActiveId(kb.id);
        const rows = await loadCorpus();
        await importTexts({
          kbId: kb.id,
          sources: rows.map((row) => ({ source: row.source || row.id, text: row.text })),
          embed: embedder.embed,
          onStage: (stage, progress) => setDemo({ stage, progress }),
        });
        await refresh();
        setDemoQuery("没有 GPU 时怎么降级");
        setTab("search");
      } catch (cause) {
        setDemoError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setDemo(null);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedder.status, items.length]);

  const active = useMemo(() => items.find((item) => item.id === activeId) ?? null, [items, activeId]);

  const createKnowledgeBase = async (name: string) => {
    const kb = await api.createKnowledgeBase(name, embedder.info?.dim ?? 512, DEFAULT_MODEL);
    await refresh();
    setActiveId(kb.id);
  };

  const deleteKnowledgeBase = async (id: string) => {
    await api.deleteKnowledgeBase(id);
    await refresh();
  };

  return (
    <div className="app">
      <Sidebar
        items={items}
        activeId={activeId}
        seekdbPath={seekdbPath}
        onSelect={setActiveId}
        onCreate={createKnowledgeBase}
        onDelete={deleteKnowledgeBase}
      />

      <main className="main">
        <StatusBar
          status={embedder.status}
          info={embedder.info}
          error={embedder.error}
          download={embedder.download}
          detected={detected}
          precision={precision}
          onPrecisionChange={setPrecision}
          onRetry={() => setReloadToken((value) => value + 1)}
        />

        {demo && (
          <p className="notice notice--info">
            首次启动正在准备示例数据：{demo.stage}
            {demo.progress > 0 ? `（${Math.round(demo.progress * 100)}%）` : ""}
          </p>
        )}
        {demoError && <p className="notice notice--warn">示例数据准备失败：{demoError}</p>}

        {bootError && (
          <p className="notice notice--error">
            无法连接本地 API：{bootError}。请确认 <code>npm run dev</code> 已启动 seekdb 服务。
          </p>
        )}

        <nav className="tabs">
          {TABS.map((item) => (
            <button
              key={item.value}
              className={tab === item.value ? "tab is-active" : "tab"}
              onClick={() => setTab(item.value)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        {tab === "import" && (
          <ImportPanel kb={active} embedder={embedder} onImported={() => void refresh()} />
        )}
        {tab === "search" && (
          <SearchPanel
            kb={active}
            embedder={embedder}
            initialQuery={demoQuery ?? undefined}
            autoRun={Boolean(demoQuery)}
            onAutoConsumed={() => setDemoQuery(null)}
          />
        )}
        {tab === "eval" && <EvalPanel embedder={embedder} onFinished={() => void refresh()} />}
      </main>
    </div>
  );
}
