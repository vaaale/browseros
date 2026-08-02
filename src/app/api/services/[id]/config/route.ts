import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
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
    // exposed/TLS-terminated there) — see docs/dev/apps/services.md §11. Under
    // the Supervisor, tell the client to connect through its already-exposed
    // port instead (tools/supervisor/supervisor.mjs's proxyServiceUpgrade for
    // WebSocket traffic, proxyServiceHttp for everything else — e.g. a WebDAV
    // service's PROPFIND/MKCOL/COPY/MOVE, which a Next.js route handler can't
    // express). Both are absent under plain `npm run dev` (no Supervisor in
    // front), where direct host:port access already works fine.
    const wsPath = supervisorEnabled() ? `/__supervisor/services/${id}/ws` : null;
    const httpPath = supervisorEnabled() ? `/__supervisor/services/${id}/` : null;

    return NextResponse.json({
      configFiles,
      runtime,
      // Always writable (035 FR-004): config is BOS-owned state under
      // dataDir()/system/config/<id>/, seeded from the item's defaults — never the
      // item's own folder. The old "read-only when from a marketplace" rule existed
      // because installing used to COPY the item into user-apps, so a marketplace
      // item's config sat in a read-only clone. Nothing is copied now. Kept in the
      // response so the client contract is unchanged.
      readOnly: false,
      configSchema: def.manifest.configSchema ?? null,
      wsPath,
      httpPath,
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
