import { NextResponse } from "next/server";
import { scrape } from "@/lib/scrape";
import { getUser } from "@/lib/telegram";

export async function GET(req: Request) {
  if (!getUser(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const raw = new URL(req.url).searchParams.get("url") || "";
  try {
    return NextResponse.json(await scrape(raw));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Ошибка" }, { status: 400 });
  }
}
