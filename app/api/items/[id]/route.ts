import { NextResponse } from "next/server";
import { deleteItem, forOwner, getItems, patchItem, type Item } from "@/lib/db";
import { cleanItemInput, requireUser, unauthorized } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  const u = await requireUser(req);
  if (!u) return unauthorized();
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const patch: Partial<Item> = {};
  if (typeof body.done === "boolean") patch.done = body.done;
  if (body.fields) {
    const f = cleanItemInput(body.fields);
    Object.assign(patch, f);
    if (!f.title) delete patch.title; // never blank out a title
  }
  const updated = await patchItem(u.id, id, patch);
  if (!updated) return NextResponse.json({ error: "Вещь не найдена" }, { status: 404 });
  return NextResponse.json({ items: forOwner(await getItems(u.id)) });
}

export async function DELETE(req: Request, { params }: Ctx) {
  const u = await requireUser(req);
  if (!u) return unauthorized();
  const { id } = await params;
  await deleteItem(u.id, id);
  return NextResponse.json({ items: forOwner(await getItems(u.id)) });
}
