import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { writeFileAtomic } from "@/os/atomic-write";

// Per-app persistent key/value store (028) backing the SDK `storage` capability
// and the localStorage shim. Each app gets its own namespace file at
// data/app-storage/<appId>.json — app-to-app isolation is enforced HERE by
// keying on the app id (supplied by the trusted parent broker, never the
// sandboxed iframe), so opaque-origin apps get durable, isolated storage.
export const dynamic = "force-dynamic";

type Store = Record<string, string>;

function fileFor(appId: string): string | null {
  const id = (appId || "").trim();
  // Conservative filename charset; reject anything that could escape the dir.
  if (!id || !/^[a-zA-Z0-9._-]+$/.test(id) || id === "." || id === "..") return null;
  return path.join(dataDir(), "app-storage", `${id}.json`);
}

async function readStore(file: string): Promise<Store> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

/** Full snapshot for an app — used by the localStorage shim's synchronous hydrate. */
export async function GET(req: NextRequest) {
  const file = fileFor(new URL(req.url).searchParams.get("app") ?? "");
  if (!file) return NextResponse.json({ error: "invalid app id" }, { status: 400 });
  return NextResponse.json({ data: await readStore(file) });
}

export async function POST(req: NextRequest) {
  let body: { app?: string; op?: string; key?: unknown; value?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const file = fileFor(body.app ?? "");
  if (!file) return NextResponse.json({ error: "invalid app id" }, { status: 400 });

  try {
    const store = await readStore(file);
    switch (body.op) {
      case "get":
        return NextResponse.json({ result: store[String(body.key)] ?? null });
      case "keys":
        return NextResponse.json({ result: Object.keys(store) });
      case "set":
        store[String(body.key)] = String(body.value ?? "");
        await writeFileAtomic(file, JSON.stringify(store));
        return NextResponse.json({ result: { ok: true } });
      case "remove":
        delete store[String(body.key)];
        await writeFileAtomic(file, JSON.stringify(store));
        return NextResponse.json({ result: { ok: true } });
      default:
        return NextResponse.json({ error: `unknown op: ${body.op}` }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
