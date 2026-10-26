import { useState } from "react";
import type { KnowledgeBase } from "../types";

interface Props {
  items: KnowledgeBase[];
  activeId: string | null;
  seekdbPath?: string;
  onSelect: (id: string) => void;
  onCreate: (name: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

export function Sidebar({ items, activeId, seekdbPath, onSelect, onCreate, onDelete }: Props) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const value = name.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      await onCreate(value);
      setName("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span className="sidebar__logo">SF</span>
        <div>
          <strong>端侧迷你知识库</strong>
          <span>StepFun × seekdb</span>
        </div>
      </div>

      <div className="sidebar__section">
        <span className="sidebar__title">知识库</span>
        <ul className="kblist">
          {items.length === 0 && <li className="kblist__empty">还没有知识库，先创建一个</li>}
          {items.map((kb) => (
            <li key={kb.id} className={kb.id === activeId ? "kblist__item is-active" : "kblist__item"}>
              <button className="kblist__select" onClick={() => onSelect(kb.id)}>
                <span className="kblist__name">{kb.name}</span>
                <span className="kblist__meta">
                  {kb.docCount < 0 ? "统计失败" : `${kb.docCount} 片段 · ${kb.dim} 维`}
                </span>
              </button>
              <button
                className="kblist__delete"
                title="删除知识库"
                onClick={() => {
                  if (confirm(`删除知识库「${kb.name}」？该操作会移除 seekdb 中对应集合。`)) void onDelete(kb.id);
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>

        <div className="sidebar__create">
          <input
            value={name}
            placeholder="新知识库名称"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
          />
          <button className="primary" onClick={() => void submit()} disabled={busy}>
            创建
          </button>
        </div>
      </div>

      <div className="sidebar__footer">
        <span className="sidebar__title">存储</span>
        <code>seekdb · embedded</code>
        {seekdbPath && <span className="sidebar__path" title={seekdbPath}>{seekdbPath}</span>}
      </div>
    </aside>
  );
}
