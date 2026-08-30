import "server-only";
import { NextResponse } from "next/server";
import { EventApiError } from "./types";
import { startEventKernel } from "./kernel";

/** Every route calls this first — idempotent, defends against a request
 *  landing before instrumentation.ts's boot sequence has started the kernel
 *  (e.g. a fast dev-server reload). */
export async function ensureKernelReady(): Promise<void> {
  await startEventKernel();
}

export function eventErrorResponse(err: unknown): NextResponse {
  if (err instanceof EventApiError) {
    return NextResponse.json({ error: { code: err.code, message: err.message } }, { status: err.status });
  }
  console.error("[events] unexpected error", err);
  return NextResponse.json(
    { error: { code: "internal", message: (err as Error).message ?? "internal error" } },
    { status: 500 },
  );
}
