import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Returns whether BOS is running in multi-user mode (launched by a bastion) and,
// if so, the current user's username (injected by the bastion proxy as
// x-bos-username). BOS_PUBLIC_PORT is set by the bastion when it spawns a user
// container — its presence is the canonical server-side multi-user signal.
export async function GET(req: NextRequest) {
  const multiUser = !!process.env.BOS_PUBLIC_PORT;
  const username = multiUser ? (req.headers.get("x-bos-username") ?? null) : null;
  return NextResponse.json({ multiUser, username });
}
