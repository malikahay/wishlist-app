import { NextResponse } from "next/server";
import { forGuest, getItems, getProfile } from "@/lib/db";
import { requireUser, unauthorized } from "@/lib/api";

export async function GET(req: Request, { params }: { params: Promise<{ userId: string }> }) {
  const u = await requireUser(req);
  if (!u) return unauthorized();
  const ownerId = Number((await params).userId);
  const owner = Number.isSafeInteger(ownerId) ? await getProfile(ownerId) : null;
  if (!owner) return NextResponse.json({ error: "Вишлист не найден" }, { status: 404 });
  return NextResponse.json({ owner, items: forGuest(await getItems(ownerId), u.id) });
}
