import { NextResponse } from "next/server";
import { forOwner, updateItems, type Item } from "@/lib/db";
import { cleanItemInput, requireUser, unauthorized } from "@/lib/api";

export async function POST(req: Request) {
  const u = await requireUser(req);
  if (!u) return unauthorized();
  const input = cleanItemInput(await req.json());
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
  const items = await updateItems(u.id, (list) => [item, ...list].slice(0, 300));
  return NextResponse.json({ items: forOwner(items) });
}
