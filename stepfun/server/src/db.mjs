/**
 * seekdb access layer.
 *
 * The browser owns embedding; this process only stores vectors and runs the
 * hybrid retrieval. Fusion happens inside seekdb through DBMS_HYBRID_SEARCH,
 * which seekdb-js reaches via collection.hybridSearch() and RRF ranking.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SeekdbClient, Schema, FulltextIndexConfig, VectorIndexConfig } from "seekdb";

const COLLECTION_PREFIX = "kb_";

function nowIso() {
  return new Date().toISOString();
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export class KnowledgeBaseStore {
  #client = null;
  #registryPath = "";
  #registry = { version: 1, knowledgeBases: [] };

  constructor({ dataDir, database, defaultDim }) {
    this.dataDir = dataDir;
    this.database = database;
    this.defaultDim = defaultDim;
    this.dbPath = path.join(dataDir, "seekdb");
    this.#registryPath = path.join(dataDir, "knowledge-bases.json");
  }

  async init() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.#registry = readJson(this.#registryPath, this.#registry);
    this.#client = new SeekdbClient({ path: this.dbPath, database: this.database });
    return this;
  }

  #persist() {
    writeJson(this.#registryPath, this.#registry);
  }

  #entry(id) {
    const entry = this.#registry.knowledgeBases.find((kb) => kb.id === id);
    if (!entry) {
      const error = new Error(`knowledge base not found: ${id}`);
      error.statusCode = 404;
      throw error;
    }
    return entry;
  }

  async #collectionOf(entry) {
    // embeddingFunction: null keeps vectors client-supplied; without it seekdb-js
    // tries to resolve the optional default-embed package.
    return this.#client.getCollection({ name: entry.collection, embeddingFunction: null });
  }

  async list() {
    const items = [];
    for (const kb of this.#registry.knowledgeBases) {
      let docCount = 0;
      try {
        const collection = await this.#collectionOf(kb);
        docCount = await collection.count();
      } catch {
        docCount = -1;
      }
      items.push({ ...kb, docCount });
    }
    return items;
  }

  async create({ name, dim, model }) {
    const id = crypto.randomBytes(4).toString("hex");
    const collectionName = `${COLLECTION_PREFIX}${id}`;
    const dimension = Number(dim || this.defaultDim);

    const schema = new Schema({
      fulltextIndex: new FulltextIndexConfig("ik", { ik_mode: "smart" }),
      vectorIndex: new VectorIndexConfig({
        hnsw: { dimension, distance: "cosine" },
        embeddingFunction: null,
      }),
    });
    const started = Date.now();
    await this.#client.createCollection({ name: collectionName, schema });
    const entry = {
      id,
      name: name?.trim() || `知识库 ${this.#registry.knowledgeBases.length + 1}`,
      collection: collectionName,
      dim: dimension,
      model: model || "",
      createdAt: nowIso(),
    };
    this.#registry.knowledgeBases.push(entry);
    this.#persist();
    return { ...entry, docCount: 0, createMs: Date.now() - started };
  }

  async remove(id) {
    const entry = this.#entry(id);
    try {
      await this.#client.deleteCollection(entry.collection);
    } catch {
      /* collection may already be gone; registry cleanup still matters */
    }
    this.#registry.knowledgeBases = this.#registry.knowledgeBases.filter((kb) => kb.id !== id);
    this.#persist();
    return { id, removed: true };
  }

  /**
   * Appends a batch of already-embedded chunks. Vectors come from the browser,
   * so the collection is configured with embeddingFunction: null.
   */
  async addDocs(id, docs) {
    const entry = this.#entry(id);
    if (!Array.isArray(docs) || docs.length === 0) return { added: 0, total: 0, ms: 0 };

    const collection = await this.#collectionOf(entry);
    const ids = [];
    const documents = [];
    const embeddings = [];
    const metadatas = [];

    for (const doc of docs) {
      const vector = doc.embedding;
      if (!Array.isArray(vector) || vector.length !== entry.dim) {
        const error = new Error(
          `embedding dimension mismatch for ${doc.id}: expected ${entry.dim}, got ${Array.isArray(vector) ? vector.length : "none"}`
        );
        error.statusCode = 400;
        throw error;
      }
      ids.push(String(doc.id));
      documents.push(String(doc.text ?? ""));
      embeddings.push(vector);
      metadatas.push({
        source: String(doc.source ?? "unknown"),
        chunk: Number(doc.chunk ?? 0),
        ...(doc.meta && typeof doc.meta === "object" ? doc.meta : {}),
      });
    }

    const started = Date.now();
    // upsert keeps re-importing the same file idempotent: chunk ids are stable,
    // so a plain insert would hit the primary key on the second import.
    await collection.upsert({ ids, documents, embeddings, metadatas });
    const ms = Date.now() - started;
    const total = await collection.count();
    return { added: ids.length, total, ms };
  }

  /**
   * Runs vector + fulltext retrieval inside seekdb and fuses both branches with
   * RRF inside the database. `mode` only narrows which branches are requested.
   */
  async search(id, { text, embedding, k = 10, mode = "hybrid", rankWindowSize, rankConstant }) {
    const entry = this.#entry(id);
    if (!Array.isArray(embedding) || embedding.length !== entry.dim) {
      const error = new Error(`query embedding must have ${entry.dim} dimensions`);
      error.statusCode = 400;
      throw error;
    }

    const collection = await this.#collectionOf(entry);
    const branchSize = Math.max(k * 4, 40);
    const options = { nResults: k, include: ["documents", "metadatas", "distances"] };

    if (mode === "hybrid") {
      options.query = { whereDocument: { $contains: text }, nResults: branchSize };
      options.knn = { queryEmbeddings: [embedding], nResults: branchSize };
      options.rank = {
        rrf: {
          rankWindowSize: rankWindowSize || branchSize,
          rankConstant: rankConstant || 60,
        },
      };
    } else if (mode === "vector") {
      options.knn = { queryEmbeddings: [embedding], nResults: branchSize };
    } else {
      options.query = { whereDocument: { $contains: text }, nResults: branchSize };
    }

    const started = Date.now();
    const result = await collection.hybridSearch(options);
    const ms = Date.now() - started;

    const hitIds = result.ids?.[0] ?? [];
    const docs = result.documents?.[0] ?? [];
    const metas = result.metadatas?.[0] ?? [];
    const distances = result.distances?.[0] ?? [];

    return {
      mode,
      ms,
      hits: hitIds.map((hitId, index) => ({
        id: hitId,
        text: docs[index] ?? "",
        meta: metas[index] ?? {},
        distance: typeof distances[index] === "number" ? distances[index] : null,
        rank: index + 1,
      })),
    };
  }

  async info() {
    return {
      engine: "seekdb",
      mode: "embedded",
      path: this.dbPath,
      database: this.database,
      collections: this.#registry.knowledgeBases.length,
    };
  }

  async close() {
    try {
      await this.#client?.close?.();
    } catch {
      /* best effort: the native runtime prints its own teardown notice */
    }
  }
}
