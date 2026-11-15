import { NextResponse } from "next/server";
import { scrape } from "@/lib/scrape";
import { requireUser, unauthorized } from "@/lib/api";
import { allowUser, LIMIT_MESSAGE } from "@/lib/limits";

export const maxDuration = 60;

export async function GET(req: Request) {
  const u = await requireUser(req);
  if (!u) return unauthorized();
  if (!(await allowUser("preview", u.id))) return NextResponse.json({ error: LIMIT_MESSAGE }, { status: 429 });
  const raw = new URL(req.url).searchParams.get("url") || "";
  try {
    return NextResponse.json(await scrape(raw));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Ошибка" }, { status: 400 });
  }
}
