import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { writeFileAtomic } from "@/os/atomic-write";
import { serviceRegistry } from "@/core/service/ServiceRegistry";
import { supervisorEnabled } from "@/lib/devharness/supervisor";
import { logger } from "@/lib/logging";
import type { RuntimeState } from "@/core/service/types";

export const dynamic = "force-dynamic";

interface ConfigFileView {
  name: string;
  values: Record<string, unknown>;
}

function isReadOnly(itemPath: string): boolean {
  // Marketplace-sourced items are read-only; user-apps items are writable
  // (spec: "Config files are read-only when from marketplace (external),
  // writable in user-apps").
  const marketplaceRoot = path.join(dataDir(), "marketplace");
  return itemPath.startsWith(marketplaceRoot + path.sep);
}

async function readJsonSafe(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// GET — list every <name>.json config file in the service's config directory
// (excluding runtime.json, which is manager-owned) plus the runtime state.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const def = serviceRegistry().getService(id);
    if (!def) return NextResponse.json({ error: "unknown or not-installed service" }, { status: 404 });

    const entries = await fs.readdir(def.configDirPath).catch(() => [] as string[]);
    const configFiles: ConfigFileView[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry === "runtime.json") continue;
      const values = await readJsonSafe(path.join(def.configDirPath, entry));
      if (values) configFiles.push({ name: entry.replace(/\.json$/, ""), values });
    }

    const runtime = (await readJsonSafe(path.join(def.configDirPath, "runtime.json"))) as RuntimeState | null;

    // A service's own port generally isn't reachable directly once BOS is
    // deployed behind a reverse proxy (only the Supervisor's public port is
    // exposed/TLS-terminated there) — see docs/dev/apps/services.md's Known
    // limitations. Under the Supervisor, tell the client to connect through
    // its already-exposed port instead (tools/supervisor/supervisor.mjs's
    // proxyServiceUpgrade). Absent under plain `npm run dev` (no Supervisor
    // in front), where direct host:port access already works fine.
    const wsPath = supervisorEnabled() ? `/__supervisor/services/${id}/ws` : null;

    return NextResponse.json({
      configFiles,
      runtime,
      readOnly: isReadOnly(def.itemPath),
      configSchema: def.manifest.configSchema ?? null,
      wsPath,
    });
  } catch (err) {
    logger().error("services.api", `GET /api/services/${id}/config failed`, err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// PATCH { file: string, patch: Record<string, unknown> } — auto-save: merges
// `patch` into <configDirPath>/<file>.json directly, no Save button (FR-032).
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const def = serviceRegistry().getService(id);
    if (!def) return NextResponse.json({ error: "unknown or not-installed service" }, { status: 404 });

    if (isReadOnly(def.itemPath)) {
      return NextResponse.json({ error: "This service's config comes from a read-only marketplace source." }, { status: 403 });
    }

    const body = await req.json();
    const { file, patch } = body as { file?: string; patch?: Record<string, unknown> };
    if (!file || !/^[a-zA-Z0-9._-]+$/.test(file) || file === "runtime") {
      return NextResponse.json({ error: "invalid or reserved config file name" }, { status: 400 });
    }
    if (!patch || typeof patch !== "object") {
      return NextResponse.json({ error: "patch object is required" }, { status: 400 });
    }

    const filePath = path.join(def.configDirPath, `${file}.json`);
    const current = (await readJsonSafe(filePath)) ?? {};
    const next = { ...current, ...patch };
    await writeFileAtomic(filePath, JSON.stringify(next, null, 2));

    return NextResponse.json({ ok: true, values: next });
  } catch (err) {
    logger().error("services.api", `PATCH /api/services/${id}/config failed`, err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
