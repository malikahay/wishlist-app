import { NextResponse } from "next/server";
import { requireUser, unauthorized } from "@/lib/api";
import { analyzeScreenshot, MAX_UPLOAD_BYTES } from "@/lib/screenshot";
import { allowUser, LIMIT_MESSAGE } from "@/lib/limits";

export const maxDuration = 90;

/** Mini App upload: screenshot in, prefilled card draft out. */
export async function POST(req: Request) {
  const u = await requireUser(req);
  if (!u) return unauthorized();
  // reject oversized bodies before parsing them
  if (Number(req.headers.get("content-length") || 0) > MAX_UPLOAD_BYTES + 64_000) {
    return NextResponse.json({ error: "Файл слишком большой" }, { status: 413 });
  }
  if (!(await allowUser("screenshot", u.id))) return NextResponse.json({ error: LIMIT_MESSAGE }, { status: 429 });
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof Blob) || !/^image\/(jpeg|png|webp)$/.test(file.type)) {
    return NextResponse.json({ error: "Нужна картинка (JPG, PNG или WebP)" }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) return NextResponse.json({ error: "Файл слишком большой" }, { status: 413 });
  try {
    const r = await analyzeScreenshot(Buffer.from(await file.arrayBuffer()));
    if (!r) return NextResponse.json({ error: "Не похоже на товар — попробуй другой скриншот" }, { status: 422 });
    return NextResponse.json({ url: "", ...r });
  } catch (e) {
    console.error("screenshot failed", e);
    return NextResponse.json({ error: "Не получилось прочитать скриншот" }, { status: 502 });
  }
}
