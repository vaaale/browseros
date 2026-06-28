import "server-only";
import * as esbuild from "esbuild";
import { promises as fs } from "fs";
import path from "path";

// Per-app build step. An app project (TS/TSX/CSS, multiple files, may import
// React) is bundled with esbuild into a static `dist/` that runs in the sandbox
// iframe. React (and any other BOS dependency) is "provided" — esbuild resolves
// bare imports against BOS's own node_modules via nodePaths — so apps need no
// per-app `npm install`.

const REPO = process.cwd();

// Caps so reading an agent-authored project directory can't blow up memory.
const MAX_FILES = 300;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next"]);

/**
 * Read an agent-authored project directory into a flat { relPath: content } map
 * of text files (used by the buildApp flow: the developer writes the project to
 * a staging dir, the server reads it and installs it). Skips build/dep dirs and
 * binary/oversized files. Capped to avoid runaway reads.
 */
export async function readProjectDir(dir: string): Promise<Record<string, string>> {
  const root = path.resolve(dir);
  const files: Record<string, string> = {};
  let count = 0;
  let total = 0;
  async function walk(abs: string, rel: string): Promise<void> {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    for (const e of entries) {
      const childAbs = path.join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        await walk(childAbs, childRel);
      } else if (e.isFile()) {
        if (count >= MAX_FILES) throw new Error(`project has too many files (>${MAX_FILES})`);
        const stat = await fs.stat(childAbs);
        if (stat.size > MAX_FILE_BYTES) continue; // skip oversized/binary blobs
        total += stat.size;
        if (total > MAX_TOTAL_BYTES) throw new Error("project exceeds total size cap");
        const buf = await fs.readFile(childAbs);
        if (buf.includes(0)) continue; // skip binary files
        files[childRel] = buf.toString("utf8");
        count++;
      }
    }
  }
  await walk(root, "");
  return files;
}

const ASSET_LOADERS: Record<string, esbuild.Loader> = {
  ".png": "dataurl",
  ".jpg": "dataurl",
  ".jpeg": "dataurl",
  ".gif": "dataurl",
  ".svg": "dataurl",
  ".webp": "dataurl",
  ".woff": "dataurl",
  ".woff2": "dataurl",
};

/**
 * Bundle `<appDir>/<entry>` into `<appDir>/dist/` (bundle.js [+ bundle.css] and a
 * generated index.html shell that mounts into <div id="root">). Throws with the
 * esbuild diagnostics if the build fails, so a bad app never silently "installs".
 */
export async function buildAppDir(appDir: string, entry: string, name: string): Promise<void> {
  const entryAbs = path.resolve(appDir, entry);
  // Keep the entry inside the app dir (no escaping the project).
  if (entryAbs !== appDir && !entryAbs.startsWith(appDir + path.sep)) {
    throw new Error(`entry "${entry}" is outside the app directory`);
  }
  const outdir = path.join(appDir, "dist");
  await fs.rm(outdir, { recursive: true, force: true }).catch(() => {});

  const result = await esbuild.build({
    entryPoints: { bundle: entryAbs },
    bundle: true,
    format: "iife",
    outdir,
    jsx: "automatic",
    nodePaths: [path.join(REPO, "node_modules")],
    minify: true,
    sourcemap: false,
    logLevel: "silent",
    loader: ASSET_LOADERS,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (result.errors.length) {
    throw new Error(`App build failed: ${result.errors.map((e) => e.text).join("; ")}`);
  }

  const hasCss = await fs
    .access(path.join(outdir, "bundle.css"))
    .then(() => true)
    .catch(() => false);
  const safeTitle = name.replace(/[<>&"]/g, "");
  const cssLink = hasCss ? '<link rel="stylesheet" href="bundle.css"/>' : "";
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"/>` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"/>` +
    `<title>${safeTitle}</title>${cssLink}</head>` +
    `<body><div id="root"></div><script src="bundle.js"></script></body></html>`;
  await fs.writeFile(path.join(outdir, "index.html"), html);
}
