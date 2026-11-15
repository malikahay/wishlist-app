import { NextResponse } from "next/server";
import { forOwner, updateItems } from "@/lib/db";
import { cleanItemInput, requireUser, unauthorized } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  const u = await requireUser(req);
  if (!u) return unauthorized();
  const { id } = await params;
  const body = await req.json();
  const edits = body.fields ? cleanItemInput({ ...body.fields }) : null;
  const items = await updateItems(u.id, (list) =>
    list.map((i) => {
      if (i.id !== id) return i;
      const next = { ...i };
      if (typeof body.done === "boolean") next.done = body.done;
      if (edits) Object.assign(next, { ...edits, url: edits.url || i.url, title: edits.title || i.title });
      return next;
    }),
  );
  return NextResponse.json({ items: forOwner(items) });
}

export async function DELETE(req: Request, { params }: Ctx) {
  const u = await requireUser(req);
  if (!u) return unauthorized();
  const { id } = await params;
  const items = await updateItems(u.id, (list) => list.filter((i) => i.id !== id));
  return NextResponse.json({ items: forOwner(items) });
}
