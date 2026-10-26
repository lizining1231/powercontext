/**
 * seekdb embedded runtime helpers.
 *
 * Two Linux quirks are handled here so a judge can run the app with a single
 * `npm run dev`:
 *   1. Ubuntu 24.04 ships libaio as `libaio.so.1t64`, while libseekdb links
 *      against the unversioned SONAME `libaio.so.1`.
 *   2. dlopen of libseekdb.so fails with "cannot allocate memory in static TLS
 *      block" when it is loaded lazily after Node has already started; preloading
 *      it through LD_PRELOAD resolves the TLS reservation.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const AIO_CANDIDATES = [
  "/lib/x86_64-linux-gnu/libaio.so.1t64",
  "/lib/aarch64-linux-gnu/libaio.so.1t64",
  "/lib/x86_64-linux-gnu/libaio.so.1",
  "/lib/aarch64-linux-gnu/libaio.so.1",
  "/usr/lib/x86_64-linux-gnu/libaio.so.1",
  "/usr/lib/aarch64-linux-gnu/libaio.so.1",
];

function bindingsCacheDir() {
  return process.env.SEEKDB_BINDINGS_CACHE_DIR || path.join(os.homedir(), ".seekdb", "bindings");
}

function findLibseekdb() {
  const roots = [bindingsCacheDir()];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name === "libseekdb.so") return full;
      }
    }
  }
  return null;
}

function ensureAioShim(repoRoot) {
  if (process.platform !== "linux") return null;
  try {
    const found = execFileSync("sh", ["-c", "ldconfig -p | grep -q 'libaio.so.1 ' && echo yes"], {
      encoding: "utf8",
    }).trim();
    if (found === "yes") return null;
  } catch {
    /* ldconfig missing or no unversioned libaio; fall through to the shim */
  }

  const source = AIO_CANDIDATES.find((p) => fs.existsSync(p));
  if (!source) return null;

  const runtimeDir = path.join(repoRoot, ".runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const shim = path.join(runtimeDir, "libaio.so.1");
  if (!fs.existsSync(shim)) fs.symlinkSync(source, shim);
  return runtimeDir;
}

function prepareBindings(repoRoot) {
  // First run downloads the native runtime into the seekdb cache directory.
  const script = `
    import("@seekdb/js-bindings")
      .then((m) => (m.getNativeBindingAsync || (m.default && m.default.getNativeBindingAsync))?.())
      .catch((err) => { console.error("[seekdb] bindings prepare: " + err.message); });
  `;
  try {
    execFileSync(process.execPath, ["-e", script], { cwd: repoRoot, stdio: "inherit" });
  } catch {
    /* the download still completes even if the addon cannot be loaded yet */
  }
}

/**
 * Builds the environment used to launch the seekdb-backed server.
 * @param {string} repoRoot absolute path of the stepfun directory
 * @returns {NodeJS.ProcessEnv}
 */
export function buildSeekdbEnv(repoRoot) {
  const env = { ...process.env };
  if (process.platform !== "linux") return env;

  const shimDir = ensureAioShim(repoRoot);
  if (shimDir) {
    env.LD_LIBRARY_PATH = [shimDir, env.LD_LIBRARY_PATH].filter(Boolean).join(":");
  }

  let lib = findLibseekdb();
  if (!lib) {
    prepareBindings(repoRoot);
    lib = findLibseekdb();
  }
  if (lib && !env.LD_PRELOAD) {
    env.LD_PRELOAD = lib;
    process.stderr.write(`[seekdb] preloading ${lib}\n`);
  }
  return env;
}
