/**
 * HTTP API for the mini knowledge base.
 *
 * Embeddings never leave the browser: the client posts ready-made vectors, and
 * this process forwards them to seekdb. Retrieval is a single seekdb hybrid
 * search (DBMS_HYBRID_SEARCH + RRF), not a client-side merge of two result sets.
 */
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { config } from "./config.mjs";
import { KnowledgeBaseStore } from "./db.mjs";

const store = await new KnowledgeBaseStore({
  dataDir: config.dataDir,
  database: config.database,
  defaultDim: config.defaultDim,
}).init();

const app = express();
app.use(express.json({ limit: "64mb" }));

function handle(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((error) => {
      const status = error.statusCode || 500;
      if (status >= 500) console.error("[api]", error);
      res.status(status).json({ error: error.message || String(error) });
    });
  };
}

app.get("/api/health", handle(async (_req, res) => {
  res.json({
    ok: true,
    seekdb: await store.info(),
    defaultDim: config.defaultDim,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  });
}));

app.get("/api/kb", handle(async (_req, res) => {
  res.json({ items: await store.list() });
}));

app.post("/api/kb", handle(async (req, res) => {
  res.json(await store.create(req.body ?? {}));
}));

app.delete("/api/kb/:id", handle(async (req, res) => {
  res.json(await store.remove(req.params.id));
}));

app.post("/api/kb/:id/docs", handle(async (req, res) => {
  res.json(await store.addDocs(req.params.id, req.body?.docs ?? []));
}));

app.post("/api/kb/:id/search", handle(async (req, res) => {
  const { text = "", embedding, k = 10, mode = "hybrid" } = req.body ?? {};
  res.json(await store.search(req.params.id, { text, embedding, k, mode }));
}));

if (fs.existsSync(config.webDist)) {
  app.use(express.static(config.webDist));
  app.get("*", (_req, res) => res.sendFile(path.join(config.webDist, "index.html")));
}

const server = app.listen(config.port, () => {
  console.log(`[stepfun] API listening on http://127.0.0.1:${config.port}`);
  console.log(`[stepfun] seekdb embedded data: ${store.dbPath}`);
  if (fs.existsSync(config.webDist)) {
    console.log("[stepfun] serving built web app from web/dist");
  }
});

async function shutdown(signal) {
  console.log(`[stepfun] ${signal} received, shutting down`);
  server.close();
  await store.close();
  setTimeout(() => process.exit(0), 200);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
