import { NextResponse } from "next/server";
import { forOwner, getItems } from "@/lib/db";
import { requireUser, unauthorized } from "@/lib/api";

export async function GET(req: Request) {
  const u = await requireUser(req);
  if (!u) return unauthorized();
  return NextResponse.json({ user: { id: u.id, name: u.first_name }, items: forOwner(await getItems(u.id)) });
}
