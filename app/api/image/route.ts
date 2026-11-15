import { safeFetch } from "@/lib/net";
import { getImage } from "@/lib/db";
import { allowIp } from "@/lib/limits";

const CACHE = "public, max-age=86400, s-maxage=604800";
const MAX_IMAGE_BYTES = 8_000_000;

/**
 * Serves item images:
 * - `img:<id>`  cropped photo from a screenshot (our storage)
 * - `tg:<file_id>`  a photo sent to the bot (fetched from Telegram without exposing the token)
 * - anything else: a shop image proxied (SSRF-safe, size-capped, IP rate-limited) to get past hotlink protection.
 */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("url") || "";
  try {
    if (raw.startsWith("img:")) {
      const buf = await getImage(raw.slice(4));
      if (!buf) return new Response(null, { status: 404 });
      return new Response(new Uint8Array(buf), {
        headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable" },
      });
    }
    if (!(await allowIp(req, "image", 120))) return new Response(null, { status: 429 });
    if (raw.startsWith("tg:")) return await telegramFile(raw.slice(3));

    const target = new URL(raw);
    const res = await safeFetch(raw, {
      headers: { Referer: target.origin + "/", Accept: "image/avif,image/webp,image/*,*/*;q=0.8" },
      maxBytes: MAX_IMAGE_BYTES,
      timeoutMs: 10_000,
    });
    if (!res.ok || !/^image\/(jpeg|png|webp|gif|avif)/.test(res.contentType)) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(res.body), { headers: { "Content-Type": res.contentType, "Cache-Control": CACHE } });
  } catch {
    return new Response(null, { status: 400 });
  }
}

async function telegramFile(fileId: string) {
  const token = process.env.BOT_TOKEN;
  if (!token || !/^[\w-]{10,200}$/.test(fileId)) return new Response(null, { status: 404 });
  const info = await (await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`)).json();
  if (!info.ok || (info.result.file_size ?? 0) > MAX_IMAGE_BYTES) return new Response(null, { status: 404 });
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${info.result.file_path}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return new Response(null, { status: 404 });
  return new Response(res.body, {
    headers: { "Content-Type": res.headers.get("content-type") || "image/jpeg", "Cache-Control": CACHE },
  });
}
