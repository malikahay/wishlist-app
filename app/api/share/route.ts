import { NextResponse } from "next/server";
import { getShareToken } from "@/lib/db";
import { requireUser, unauthorized } from "@/lib/api";

/** GET → current share token (created on first use). POST → revoke old link and issue a new token. */
export async function GET(req: Request) {
  const u = await requireUser(req);
  if (!u) return unauthorized();
  return NextResponse.json({ token: await getShareToken(u.id) });
}

export async function POST(req: Request) {
  const u = await requireUser(req);
  if (!u) return unauthorized();
  return NextResponse.json({ token: await getShareToken(u.id, true) });
}
