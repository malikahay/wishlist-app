import { NextResponse } from "next/server";
import { addItem, forOwner, getItems, MAX_ITEMS, type Item } from "@/lib/db";
import { cleanItemInput, requireUser, unauthorized } from "@/lib/api";

export async function POST(req: Request) {
  const u = await requireUser(req);
  if (!u) return unauthorized();
  const input = cleanItemInput(await req.json().catch(() => ({})));
  if (!input.url && !input.title && !input.image) {
    return NextResponse.json({ error: "Добавь ссылку или скриншот" }, { status: 400 });
  }
  const item: Item = {
    ...input,
    title: input.title || input.site || "Без названия",
    id: crypto.randomUUID(),
    done: false,
    createdAt: Date.now(),
    reservedBy: null,
  };
  if (!(await addItem(u.id, item))) {
    return NextResponse.json({ error: `В вишлисте уже ${MAX_ITEMS} вещей` }, { status: 409 });
  }
  return NextResponse.json({ items: forOwner(await getItems(u.id)) });
}
