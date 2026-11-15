import { NextResponse } from "next/server";
import { forGuest, getItems, getProfile, ownerByToken } from "@/lib/db";
import { requireUser, unauthorized } from "@/lib/api";

/** A friend's view of a wishlist, reachable only through its share token. */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const u = await requireUser(req);
  if (!u) return unauthorized();
  const ownerId = await ownerByToken((await params).token);
  const owner = ownerId != null ? await getProfile(ownerId) : null;
  if (!owner) return NextResponse.json({ error: "Ссылка устарела или вишлист не найден" }, { status: 404 });
  // the owner opening their own link must not learn which gifts are taken
  if (owner.id === u.id) return NextResponse.json({ own: true });
  return NextResponse.json({ owner: { name: owner.name }, items: forGuest(await getItems(owner.id), u.id) });
}
