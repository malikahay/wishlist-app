import { NextResponse, after } from "next/server";
import crypto from "node:crypto";
import { tg, displayName, type TgUser } from "@/lib/telegram";
import { addItem, firstTime, getItems, patchItem, putTemp, saveProfile, takeTemp, type Item } from "@/lib/db";
import { scrape } from "@/lib/scrape";
import { analyzeScreenshot, MAX_UPLOAD_BYTES, type ScreenshotResult } from "@/lib/screenshot";
import { allowUser, LIMIT_MESSAGE } from "@/lib/limits";

const PHOTO_WINDOW_MS = 30 * 60 * 1000; // offer to attach a screenshot to an image-less item added in the last 30 min
const PENDING_TTL_SEC = 60 * 60;

export const maxDuration = 120;

/**
 * Telegram bot webhook. Verifies the secret, de-duplicates by update_id (Telegram retries on slow replies),
 * answers 200 immediately and does the work in `after()`.
 */
export async function POST(req: Request) {
  if (req.headers.get("x-telegram-bot-api-secret-token") !== process.env.WEBHOOK_SECRET) {
    return new NextResponse(null, { status: 403 });
  }
  const update = await req.json().catch(() => null);
  if (!update?.update_id || !(await firstTime(`wl:upd:${update.update_id}`, 86_400))) {
    return NextResponse.json({ ok: true });
  }
  const appUrl = process.env.APP_URL || `https://${req.headers.get("host")}`;
  const ctx = { appUrl, openBtn: { inline_keyboard: [[{ text: "Открыть вишлист", web_app: { url: appUrl } }]] } };

  if (update.callback_query) {
    after(() => handleCallback(update.callback_query, ctx).catch((e) => console.error("callback error", e)));
  } else if (update.message?.from && update.message.chat?.type === "private") {
    after(() => handleMessage(update.message, ctx).catch((e) => console.error("bot error", e)));
  }
  return NextResponse.json({ ok: true });
}

type Ctx = { appUrl: string; openBtn: unknown };

async function handleMessage(msg: any, ctx: Ctx) {
  const from = msg.from as TgUser;
  const chat_id = msg.chat.id;
  await saveProfile({ id: from.id, name: displayName(from), username: from.username });

  const text: string = msg.text || msg.caption || "";
  const link: string | undefined =
    text.match(/https?:\/\/\S+/i)?.[0] ??
    [...(msg.entities || []), ...(msg.caption_entities || [])].find((e: any) => e.type === "text_link")?.url;
  const photo = msg.photo?.at(-1) ?? (msg.document?.mime_type?.startsWith("image/") ? msg.document : undefined);

  if (text.startsWith("/start")) {
    await tg("sendMessage", {
      chat_id,
      text:
        `Привет, ${from.first_name}! 🌷\n\n` +
        "Присылай мне ссылки на вещи — я сам достану фото, название и цену.\n" +
        "Или пришли скриншот товара — я вырежу фото и найду цену, цвет и размер 📸\n\n" +
        "Вишлистом можно поделиться: друзья тайно забронируют подарки.",
      reply_markup: ctx.openBtn,
    });
    return;
  }

  if (photo) {
    if ((photo.file_size ?? 0) > MAX_UPLOAD_BYTES) {
      await tg("sendMessage", { chat_id, text: "Картинка слишком большая — пришли скриншот поменьше 🙏" });
      return;
    }
    if (!(await allowUser("screenshot", from.id))) {
      await tg("sendMessage", { chat_id, text: LIMIT_MESSAGE });
      return;
    }
    await tg("sendChatAction", { chat_id, action: "typing" });
    const [shot, page] = await Promise.all([
      readScreenshot(photo.file_id),
      link && (await allowUser("preview", from.id)) ? scrape(link).catch(() => null) : Promise.resolve(null),
    ]);

    if (!shot) {
      // never drop the raw screenshot into a card — say it plainly instead
      if (page) {
        const item = newItem({ url: page.url, title: page.title, image: page.image, price: page.price, currency: page.currency, site: page.site });
        if (await addItem(from.id, item)) await replyCard(chat_id, item, "✨ Добавлено по ссылке", ctx);
      }
      await tg("sendMessage", { chat_id, text: "😕 Не получилось распознать скриншот. Попробуй чуть позже или другой скриншот." });
      return;
    }

    if (!link) {
      // a screenshot right after a link is probably for that item — but ask, don't guess
      const recent = (await getItems(from.id)).find((i) => !i.image && Date.now() - i.createdAt < PHOTO_WINDOW_MS);
      if (recent) {
        const pid = crypto.randomBytes(6).toString("base64url");
        await putTemp(`wl:pend:${from.id}:${pid}`, shot, PENDING_TTL_SEC);
        await tg("sendMessage", {
          chat_id,
          text: `Распознал: <b>${esc(shot.title)}</b>\nЭто фото к «${esc(recent.title)}» или новая вещь?`,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: `📎 К «${recent.title.slice(0, 30)}»`, callback_data: `a:${pid}:${recent.id}` }],
              [{ text: "✨ Новая вещь", callback_data: `n:${pid}` }],
            ],
          },
        });
        return;
      }
    }

    const item = newItem({
      url: page?.url ?? "",
      // a blocked shop gives only a URL-slug title; the screenshot is more accurate then
      title: (page && !page.partial ? page.title : shot.title) || page?.title || "Без названия",
      image: shot.image ?? page?.image ?? null,
      price: shot.price ?? page?.price ?? null,
      currency: shot.currency ?? page?.currency ?? null,
      site: page?.site || shot.site || "",
      note: shot.note,
    });
    if (await addItem(from.id, item)) await replyCard(chat_id, item, "✨ Добавлено", ctx);
    else await tg("sendMessage", { chat_id, text: "В вишлисте уже слишком много вещей — удали что-нибудь 🙏" });
    return;
  }

  if (link) {
    if (!(await allowUser("preview", from.id))) {
      await tg("sendMessage", { chat_id, text: LIMIT_MESSAGE });
      return;
    }
    await tg("sendChatAction", { chat_id, action: "typing" });
    let p;
    try {
      p = await scrape(link);
    } catch (e) {
      await tg("sendMessage", { chat_id, text: `Не получилось: ${e instanceof Error ? e.message : "ошибка"}` });
      return;
    }
    const item = newItem({ url: p.url, title: p.title, image: p.image, price: p.price, currency: p.currency, site: p.site });
    if (await addItem(from.id, item)) await replyCard(chat_id, item, "✨ Добавлено", ctx);
    else await tg("sendMessage", { chat_id, text: "В вишлисте уже слишком много вещей — удали что-нибудь 🙏" });
    return;
  }

  await tg("sendMessage", {
    chat_id,
    text: "Пришли мне ссылку на вещь или скриншот товара, и я добавлю её в вишлист 🎁",
    reply_markup: ctx.openBtn,
  });
}

/** Buttons under "attach this screenshot to the recent item?". */
async function handleCallback(cq: any, ctx: Ctx) {
  const uid: number = cq.from.id;
  const chat_id = cq.message?.chat?.id;
  const message_id = cq.message?.message_id;
  const [kind, pid, itemId] = String(cq.data || "").split(":");
  const shot = pid ? await takeTemp<ScreenshotResult>(`wl:pend:${uid}:${pid}`) : null;
  if (!shot) {
    await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Уже обработано или устарело" });
    return;
  }
  await tg("answerCallbackQuery", { callback_query_id: cq.id });
  if (chat_id && message_id) await tg("editMessageReplyMarkup", { chat_id, message_id, reply_markup: { inline_keyboard: [] } });

  if (kind === "a" && itemId) {
    const current = (await getItems(uid)).find((i) => i.id === itemId);
    if (current) {
      const updated = await patchItem(uid, itemId, {
        image: shot.image ?? current.image,
        title: current.title.length < 60 && shot.title ? shot.title : current.title,
        price: current.price ?? shot.price,
        currency: current.currency ?? shot.currency,
        note: current.note || shot.note,
      });
      if (updated) {
        await replyCard(chat_id, updated, "📸 Обновлено", ctx);
        return;
      }
    }
    // the item was deleted meanwhile — fall through and create a new one
  }
  const item = newItem({ title: shot.title, image: shot.image, price: shot.price, currency: shot.currency, site: shot.site, note: shot.note });
  if (await addItem(uid, item)) await replyCard(chat_id, item, "✨ Добавлено", ctx);
}

function newItem(f: Partial<Item>): Item {
  return {
    url: "",
    title: "Без названия",
    image: null,
    price: null,
    currency: null,
    site: "",
    note: "",
    ...f,
    id: crypto.randomUUID(),
    done: false,
    createdAt: Date.now(),
    reservedBy: null,
  };
}

async function readScreenshot(fileId: string): Promise<ScreenshotResult | null> {
  try {
    const info = await tg("getFile", { file_id: fileId });
    if (!info.ok || (info.result.file_size ?? 0) > MAX_UPLOAD_BYTES) return null;
    const res = await fetch(`https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${info.result.file_path}`, {
      signal: AbortSignal.timeout(15_000),
    });
    return await analyzeScreenshot(Buffer.from(await res.arrayBuffer()));
  } catch (e) {
    console.error("screenshot analysis failed", e);
    return null;
  }
}

async function replyCard(chat_id: number, item: Item, head: string, ctx: Ctx) {
  const caption =
    `${head}: <b>${esc(item.title)}</b>` +
    (item.price ? `\n💰 ${esc(item.price)} ${esc(item.currency ?? "")}` : "") +
    (item.note ? `\n${esc(item.note)}` : "") +
    (!item.image ? "\n\n<i>Магазин не отдал фото — пришли скриншот товара, я вырежу фото и цену 📸</i>" : "");
  const photo = !item.image
    ? null
    : item.image.startsWith("tg:")
      ? item.image.slice(3)
      : `${ctx.appUrl}/api/image?url=${encodeURIComponent(item.image)}`;
  const sent = photo
    ? await tg("sendPhoto", { chat_id, photo, caption, parse_mode: "HTML", reply_markup: ctx.openBtn })
    : null;
  if (!sent?.ok) await tg("sendMessage", { chat_id, text: caption, parse_mode: "HTML", reply_markup: ctx.openBtn });
}

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
