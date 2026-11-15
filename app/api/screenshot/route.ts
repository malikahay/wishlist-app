import { NextResponse } from "next/server";
import { requireUser, unauthorized } from "@/lib/api";
import { analyzeScreenshot } from "@/lib/screenshot";

export const maxDuration = 60;

/** Mini App upload: screenshot in, prefilled card draft out. */
export async function POST(req: Request) {
  const u = await requireUser(req);
  if (!u) return unauthorized();
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof Blob) || !file.type.startsWith("image/")) {
    return NextResponse.json({ error: "Нужна картинка" }, { status: 400 });
  }
  try {
    const r = await analyzeScreenshot(Buffer.from(await file.arrayBuffer()));
    if (!r) return NextResponse.json({ error: "Не похоже на товар — попробуй другой скриншот" }, { status: 422 });
    return NextResponse.json({ url: "", ...r });
  } catch (e) {
    console.error("screenshot failed", e);
    return NextResponse.json({ error: "Не получилось прочитать скриншот" }, { status: 500 });
  }
}
