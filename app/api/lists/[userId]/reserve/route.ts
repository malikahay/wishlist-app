import { NextResponse } from "next/server";
import { forGuest, updateItems } from "@/lib/db";
import { requireUser, unauthorized } from "@/lib/api";
import { displayName } from "@/lib/telegram";

/** Toggles a reservation by the viewer on someone else's item. */
export async function POST(req: Request, { params }: { params: Promise<{ userId: string }> }) {
  const u = await requireUser(req);
  if (!u) return unauthorized();
  const ownerId = Number((await params).userId);
  if (!Number.isSafeInteger(ownerId) || ownerId === u.id) {
    return NextResponse.json({ error: "Нельзя бронировать свои подарки" }, { status: 400 });
  }
  const { itemId } = await req.json();
  let conflict = false;
  const items = await updateItems(ownerId, (list) =>
    list.map((i) => {
      if (i.id !== itemId) return i;
      if (i.reservedBy && i.reservedBy.id !== u.id) {
        conflict = true;
        return i;
      }
      return { ...i, reservedBy: i.reservedBy ? null : { id: u.id, name: displayName(u) } };
    }),
  );
  if (conflict) return NextResponse.json({ error: "Этот подарок уже кто-то забронировал" }, { status: 409 });
  return NextResponse.json({ items: forGuest(items, u.id) });
}
