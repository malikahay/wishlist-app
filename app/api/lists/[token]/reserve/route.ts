import { NextResponse } from "next/server";
import { forGuest, getItems, ownerByToken, setReservation } from "@/lib/db";
import { requireUser, unauthorized } from "@/lib/api";
import { displayName } from "@/lib/telegram";

/** Body: { itemId, reserve: boolean }. Idempotent and atomic — a repeated request never flips the state. */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const u = await requireUser(req);
  if (!u) return unauthorized();
  const ownerId = await ownerByToken((await params).token);
  if (ownerId == null) return NextResponse.json({ error: "Ссылка устарела" }, { status: 404 });
  if (ownerId === u.id) return NextResponse.json({ error: "Нельзя бронировать свои подарки" }, { status: 400 });

  const { itemId, reserve } = await req.json().catch(() => ({}));
  if (typeof itemId !== "string" || typeof reserve !== "boolean") {
    return NextResponse.json({ error: "Некорректный запрос" }, { status: 400 });
  }
  const result = await setReservation(ownerId, itemId, { id: u.id, name: displayName(u) }, reserve);
  const items = forGuest(await getItems(ownerId), u.id);
  if (result === "conflict") {
    return NextResponse.json({ error: "Этот подарок уже кто-то забронировал", items }, { status: 409 });
  }
  if (result === "missing") return NextResponse.json({ error: "Вещь уже недоступна", items }, { status: 404 });
  return NextResponse.json({ items });
}
