import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Returns whether BOS is running in multi-user mode (launched by a bastion) and,
// if so, exposes a logout URL. BOS_PUBLIC_PORT is set by the bastion when it
// spawns a user container — its presence is the canonical multi-user signal.
export async function GET() {
  const multiUser = !!process.env.BOS_PUBLIC_PORT;
  return NextResponse.json({ multiUser });
}
