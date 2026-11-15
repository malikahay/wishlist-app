import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { tg } from "@/lib/telegram";

/**
 * Points the bot at this deployment: webhook, menu button, commands, description.
 * Admin-only (`x-admin-secret: $ADMIN_SECRET`); disabled entirely when ADMIN_SECRET isn't set.
 * Never drops pending updates.
 */
export async function POST(req: Request) {
  const secret = process.env.ADMIN_SECRET;
  const given = req.headers.get("x-admin-secret") || "";
  if (
    !secret ||
    given.length !== secret.length ||
    !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret))
  ) {
    return new NextResponse(null, { status: 404 });
  }
  const appUrl = (process.env.APP_URL || "").replace(/\/$/, "");
  if (!process.env.BOT_TOKEN || !process.env.WEBHOOK_SECRET || !appUrl) {
    return NextResponse.json({ error: "BOT_TOKEN, WEBHOOK_SECRET and APP_URL must be set" }, { status: 500 });
  }
  const steps = {
    setWebhook: await tg("setWebhook", {
      url: `${appUrl}/api/bot`,
      secret_token: process.env.WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"],
    }),
    setChatMenuButton: await tg("setChatMenuButton", {
      menu_button: { type: "web_app", text: "Вишлист", web_app: { url: appUrl } },
    }),
    setMyCommands: await tg("setMyCommands", { commands: [{ command: "start", description: "Открыть вишлист" }] }),
    setMyDescription: await tg("setMyDescription", {
      description:
        "Присылай ссылки на вещи или скриншоты — я соберу из них вишлист с фото и ценами. Делись им с друзьями 🌷",
    }),
    setMyShortDescription: await tg("setMyShortDescription", { short_description: "Вишлист из ссылок и скриншотов 🎁" }),
  };
  const webhook = await tg("getWebhookInfo", {});
  return NextResponse.json({
    steps: Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, v.ok ? "ok" : v.description])),
    webhook: { url: webhook.result?.url, pending: webhook.result?.pending_update_count, allowed: webhook.result?.allowed_updates },
  });
}
