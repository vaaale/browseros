import { NextResponse } from "next/server";
import { logSink } from "@/lib/logging/server-logger";
import { readLocalLogs, listLocalSessions } from "@/lib/logging/local-reader";
import type { LogLevel, LogRecord, LogStream } from "@/lib/logging/models/log-models";

// Frontend log ingestion + viewer reads.
//  - Under the Supervisor the browser posts straight to /__supervisor/logs, but this
//    route still works (ingest forwards to the Supervisor via the configured sink;
//    reads are proxied to it — the single owner of the store).
//  - In no-Supervisor dev it is the ingestion + read path against the local files.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function supervisorBase(): string {
  return (process.env.BOS_SUPERVISOR_URL || "").trim().replace(/\/$/, "");
}

// POST: ingest a batch of records (frontend, or any external producer).
export async function POST(req: Request) {
  let payload: unknown = null;
  try {
    payload = await req.json();
  } catch {
    payload = null;
  }
  const raw = Array.isArray((payload as { records?: unknown })?.records)
    ? (payload as { records: unknown[] }).records
    : Array.isArray(payload)
      ? (payload as unknown[])
      : [];
  const sessionId = req.headers.get("x-bos-session") || undefined;
  const records = raw.slice(0, 1000).map((r) => ({
    stream: "frontend" as LogStream,
    ...(sessionId ? { sessionId } : {}),
    ...(r as object),
  })) as LogRecord[];
  try {
    await logSink().ship(records);
  } catch {
    /* never fail the client on a logging error */
  }
  return NextResponse.json({ ok: true, n: records.length });
}

// GET: read the timeline for the viewer (filters: session, stream, level, since, limit).
export async function GET(req: Request) {
  const qs = new URL(req.url).searchParams;
  const sup = supervisorBase();
  if (sup) {
    try {
      const res = await fetch(`${sup}/__supervisor/logs?${qs.toString()}`, { cache: "no-store" });
      return NextResponse.json(await res.json());
    } catch {
      return NextResponse.json({ ok: false, error: "supervisor unreachable", records: [], sessions: [] });
    }
  }
  if (qs.get("sessions") === "1") {
    return NextResponse.json({ ok: true, sessions: await listLocalSessions() });
  }
  const records = await readLocalLogs({
    session: qs.get("session") || undefined,
    stream: (qs.get("stream") as LogStream) || undefined,
    level: (qs.get("level") as LogLevel) || undefined,
    since: qs.get("since") ? Number(qs.get("since")) : undefined,
    limit: qs.get("limit") ? Number(qs.get("limit")) : undefined,
  });
  return NextResponse.json({ ok: true, records });
}
