import type { KnowledgeBase, SearchResponse } from "./types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `${response.status} ${response.statusText}`);
  }
  return payload as T;
}

export const api = {
  health: () =>
    request<{ ok: boolean; seekdb: { mode: string; path: string }; defaultDim: number }>("/api/health"),

  listKnowledgeBases: () => request<{ items: KnowledgeBase[] }>("/api/kb"),

  createKnowledgeBase: (name: string, dim: number, model: string) =>
    request<KnowledgeBase>("/api/kb", {
      method: "POST",
      body: JSON.stringify({ name, dim, model }),
    }),

  deleteKnowledgeBase: (id: string) =>
    request<{ id: string; removed: boolean }>(`/api/kb/${id}`, { method: "DELETE" }),

  addDocs: (
    id: string,
    docs: Array<{ id: string; text: string; embedding: number[]; source: string; chunk: number }>,
  ) =>
    request<{ added: number; total: number; ms: number }>(`/api/kb/${id}/docs`, {
      method: "POST",
      body: JSON.stringify({ docs }),
    }),

  search: (id: string, body: { text: string; embedding: number[]; k: number; mode: string }) =>
    request<SearchResponse>(`/api/kb/${id}/search`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};
