/**
 * One-command launcher: starts the seekdb-backed API server and, unless
 * `--prod` is given, the Vite dev server for the browser app.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSeekdbEnv } from "./runtime.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prod = process.argv.includes("--prod");
const children = [];

function run(label, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    process.stderr.write(`[${label}] exited (code=${code} signal=${signal})\n`);
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 500);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const serverEnv = buildSeekdbEnv(repoRoot);
run("server", process.execPath, ["server/src/index.mjs"], serverEnv);

if (!prod) {
  const viteBin = path.join(repoRoot, "node_modules", ".bin", "vite");
  run("web", viteBin, ["--config", "web/vite.config.mts"], {});
} else {
  process.stdout.write("[stepfun] production mode: web/dist is served by the API server\n");
}
