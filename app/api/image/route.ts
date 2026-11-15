import { assertPublicUrl, fetchWithTimeout } from "@/lib/scrape";
import { getImage } from "@/lib/db";

const CACHE = "public, max-age=86400, s-maxage=604800";

/**
 * Serves item images. `tg:<file_id>` = a screenshot the user sent to the bot (fetched from Telegram
 * without exposing the bot token); anything else is a shop image proxied to get past hotlink protection.
 */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("url") || "";
  try {
    if (raw.startsWith("tg:")) return await telegramFile(raw.slice(3));
    if (raw.startsWith("img:")) {
      const buf = await getImage(raw.slice(4));
      if (!buf) return new Response(null, { status: 404 });
      return new Response(new Uint8Array(buf), {
        headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable" },
      });
    }
    const target = assertPublicUrl(raw);
    const res = await fetchWithTimeout(target.toString(), {
      headers: { Referer: target.origin + "/", Accept: "image/avif,image/webp,image/*,*/*;q=0.8" },
    });
    const type = res.headers.get("content-type") || "";
    if (!res.ok || !type.startsWith("image/")) return new Response(null, { status: 404 });
    return new Response(res.body, { headers: { "Content-Type": type, "Cache-Control": CACHE } });
  } catch {
    return new Response(null, { status: 400 });
  }
}

async function telegramFile(fileId: string) {
  const token = process.env.BOT_TOKEN;
  if (!token || !/^[\w-]+$/.test(fileId)) return new Response(null, { status: 404 });
  const info = await (await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`)).json();
  if (!info.ok) return new Response(null, { status: 404 });
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${info.result.file_path}`);
  if (!res.ok) return new Response(null, { status: 404 });
  return new Response(res.body, {
    headers: { "Content-Type": res.headers.get("content-type") || "image/jpeg", "Cache-Control": CACHE },
  });
}
