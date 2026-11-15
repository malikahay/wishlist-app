import { NextResponse, after } from "next/server";
import { tg, displayName, type TgUser } from "@/lib/telegram";
import { saveProfile, updateItems, getItems, type Item } from "@/lib/db";
import { scrape } from "@/lib/scrape";
import { analyzeScreenshot } from "@/lib/screenshot";

const PHOTO_WINDOW_MS = 30 * 60 * 1000; // a screenshot attaches to an image-less item added in the last 30 min

/**
 * Telegram bot webhook. Replies 200 immediately and does the work in `after()`,
 * so slow shops (ScrapingBee can take ~30s) don't make Telegram retry the update.
 */
export const maxDuration = 120;

export async function POST(req: Request) {
  if (req.headers.get("x-telegram-bot-api-secret-token") !== process.env.WEBHOOK_SECRET) {
    return new NextResponse(null, { status: 403 });
  }
  const update = await req.json();
  const msg = update.message;
  console.log("bot update", update.update_id, msg?.chat?.type, (msg?.text || "").slice(0, 30));
  if (!msg?.from || msg.chat?.type !== "private") return NextResponse.json({ ok: true });
  const appUrl = process.env.APP_URL || `https://${req.headers.get("host")}`;
  after(() => handle(msg, appUrl).catch((e) => console.error("bot error", e)));
  return NextResponse.json({ ok: true });
}

async function handle(msg: any, appUrl: string) {
  const from = msg.from as TgUser;
  const chat_id = msg.chat.id;
  const openBtn = { inline_keyboard: [[{ text: "Открыть вишлист", web_app: { url: appUrl } }]] };
  await saveProfile({ id: from.id, name: displayName(from), username: from.username });

  const text: string = msg.text || msg.caption || "";
  const link: string | undefined =
    text.match(/https?:\/\/\S+/i)?.[0] ??
    [...(msg.entities || []), ...(msg.caption_entities || [])].find((e: any) => e.type === "text_link")?.url;
  // largest size of an attached photo (or an image sent as a file)
  const photoId: string | undefined =
    msg.photo?.at(-1)?.file_id ?? (msg.document?.mime_type?.startsWith("image/") ? msg.document.file_id : undefined);

  if (text.startsWith("/start")) {
    await tg("sendMessage", {
      chat_id,
      text:
        `Привет, ${from.first_name}! 🌷\n\n` +
        "Присылай мне ссылки на вещи — я сам достану фото, название и цену.\n" +
        "Или просто пришли скриншот товара — я сам вырежу фото и найду цену, цвет и размер 📸\n\n" +
        "Вишлистом можно поделиться: друзья тайно забронируют подарки.",
      reply_markup: openBtn,
    });
    return;
  }

  if (photoId) {
    await tg("sendChatAction", { chat_id, action: "typing" });
    const shot = await readScreenshot(photoId);
    const page = link ? await scrape(link).catch(() => null) : null;
    const items = await getItems(from.id);
    // screenshot without a link completes the item the user just added (e.g. a blocked shop link)
    const recent = !link
      ? items.find((i) => !i.image && Date.now() - i.createdAt < PHOTO_WINDOW_MS)
      : undefined;

    if (!shot) {
      // never drop the whole screenshot into a card — say it plainly instead
      if (page) {
        const item: Item = {
          url: page.url, title: page.title, image: page.image, price: page.price, currency: page.currency,
          site: page.site, note: "", id: crypto.randomUUID(), done: false, createdAt: Date.now(), reservedBy: null,
        };
        await updateItems(from.id, (list) => [item, ...list].slice(0, 300));
        await replyCard(chat_id, item, "✨ Добавлено по ссылке", appUrl, openBtn);
      }
      await tg("sendMessage", {
        chat_id,
        text: "😕 Не получилось распознать скриншот — сервис распознавания сейчас недоступен. Попробуй чуть позже.",
      });
      return;
    }
    const image = shot.image ?? page?.image ?? null;

    let item: Item;
    if (recent) {
      item = {
        ...recent,
        image,
        title: shot.title && recent.title.length < 60 ? shot.title : recent.title,
        price: recent.price ?? shot?.price ?? null,
        currency: recent.currency ?? shot?.currency ?? null,
        note: recent.note || shot?.note || "",
      };
      await updateItems(from.id, (list) => list.map((i) => (i.id === recent.id ? item : i)));
    } else {
      item = {
        url: page?.url ?? "",
        // a blocked shop gives only a URL-slug title; the screenshot is more accurate then
        title: (page && !page.partial ? page.title : shot?.title) || page?.title || "Без названия",
        image,
        price: shot?.price ?? page?.price ?? null,
        currency: shot?.currency ?? page?.currency ?? null,
        site: page?.site || shot?.site || "",
        note: shot?.note ?? "",
        id: crypto.randomUUID(),
        done: false,
        createdAt: Date.now(),
        reservedBy: null,
      };
      await updateItems(from.id, (list) => [item, ...list].slice(0, 300));
    }
    await replyCard(chat_id, item, recent ? "📸 Обновлено" : "✨ Добавлено", appUrl, openBtn);
    return;
  }

  if (link) {
    await tg("sendChatAction", { chat_id, action: "typing" });
    const p = await scrape(link);
    const item: Item = {
      url: p.url,
      title: p.title,
      image: p.image,
      price: p.price,
      currency: p.currency,
      site: p.site,
      note: "",
      id: crypto.randomUUID(),
      done: false,
      createdAt: Date.now(),
      reservedBy: null,
    };
    await updateItems(from.id, (list) => [item, ...list].slice(0, 300));
    await replyCard(chat_id, item, "✨ Добавлено", appUrl, openBtn);
    return;
  }

  await tg("sendMessage", {
    chat_id,
    text: "Пришли мне ссылку на вещь, и я добавлю её в вишлист 🎁",
    reply_markup: openBtn,
  });
}

async function readScreenshot(fileId: string) {
  try {
    const info = await tg("getFile", { file_id: fileId });
    if (!info.ok) return null;
    const res = await fetch(`https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${info.result.file_path}`);
    return await analyzeScreenshot(Buffer.from(await res.arrayBuffer()));
  } catch (e) {
    console.error("screenshot analysis failed", e);
    return null;
  }
}

async function replyCard(chat_id: number, item: Item, head: string, appUrl: string, reply_markup: unknown) {
  const caption =
    `${head}: <b>${esc(item.title)}</b>` +
    (item.price ? `\n💰 ${esc(item.price)} ${esc(item.currency ?? "")}` : "") +
    (item.note ? `\n${esc(item.note)}` : "") +
    (!item.image ? "\n\n<i>Магазин не отдал фото — пришли скриншот товара, я сам вырежу фото и цену 📸</i>" : "");
  const photo = !item.image
    ? null
    : item.image.startsWith("tg:")
      ? item.image.slice(3)
      : `${appUrl}/api/image?url=${encodeURIComponent(item.image)}`;
  const sent = photo ? await tg("sendPhoto", { chat_id, photo, caption, parse_mode: "HTML", reply_markup }) : null;
  if (!sent?.ok) await tg("sendMessage", { chat_id, text: caption, parse_mode: "HTML", reply_markup });
}

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
