import { NextResponse } from "next/server";
import { tg } from "@/lib/telegram";

/**
 * Points the bot at this deployment: webhook, menu button, commands, description.
 * Idempotent and only ever targets APP_URL from env, so it's safe to call; it returns statuses, never secrets.
 */
export async function POST() {
  const appUrl = (process.env.APP_URL || "").replace(/\/$/, "");
  if (!process.env.BOT_TOKEN || !process.env.WEBHOOK_SECRET || !appUrl) {
    return NextResponse.json({ error: "BOT_TOKEN, WEBHOOK_SECRET and APP_URL must be set" }, { status: 500 });
  }
  const steps = {
    setWebhook: await tg("setWebhook", {
      url: `${appUrl}/api/bot`,
      secret_token: process.env.WEBHOOK_SECRET,
      allowed_updates: ["message"],
      drop_pending_updates: true,
    }),
    setChatMenuButton: await tg("setChatMenuButton", {
      menu_button: { type: "web_app", text: "Вишлист", web_app: { url: appUrl } },
    }),
    setMyCommands: await tg("setMyCommands", { commands: [{ command: "start", description: "Открыть вишлист" }] }),
    setMyDescription: await tg("setMyDescription", {
      description:
        "Присылай ссылки на вещи — я соберу из них красивый вишлист с фото и ценами. Делись им с друзьями 🌷",
    }),
    setMyShortDescription: await tg("setMyShortDescription", {
      short_description: "Вишлист из ссылок на вещи 🎁",
    }),
  };
  const me = await tg("getMe", {});
  const webhook = await tg("getWebhookInfo", {});
  return NextResponse.json({
    bot: me.result?.username,
    steps: Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, v.ok ? "ok" : v.description])),
    webhook: { url: webhook.result?.url, pending: webhook.result?.pending_update_count, lastError: webhook.result?.last_error_message },
  });
}
