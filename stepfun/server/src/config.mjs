import path from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const repoRoot = path.resolve(serverRoot, "..");

export const config = {
  port: Number(process.env.PORT || 8090),
  dataDir: process.env.SEEKDB_DATA_DIR || path.join(repoRoot, ".data"),
  database: process.env.SEEKDB_DATABASE || "test",
  defaultDim: Number(process.env.EMBEDDING_DIM || 512),
  webDist: path.join(repoRoot, "web", "dist"),
};
