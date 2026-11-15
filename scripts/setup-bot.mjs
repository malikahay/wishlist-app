// Usage: node --env-file=.env.local scripts/setup-bot.mjs https://your-app.vercel.app
// Registers the webhook, the menu button that opens the Mini App, and bot commands.
const token = process.env.BOT_TOKEN;
const secret = process.env.WEBHOOK_SECRET;
const appUrl = (process.argv[2] || process.env.APP_URL || "").replace(/\/$/, "");
if (!token || !secret || !appUrl.startsWith("https://")) {
  console.error("Need BOT_TOKEN, WEBHOOK_SECRET in env and an https app URL as argument");
  process.exit(1);
}
const call = async (method, body) => {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  console.log(method, j.ok ? "✓" : j.description);
};
await call("setWebhook", { url: `${appUrl}/api/bot`, secret_token: secret, allowed_updates: ["message", "callback_query"] });
await call("setChatMenuButton", { menu_button: { type: "web_app", text: "Вишлист", web_app: { url: appUrl } } });
await call("setMyCommands", { commands: [{ command: "start", description: "Открыть вишлист" }] });
await call("setMyDescription", {
  description: "Присылай ссылки на вещи — я соберу из них красивый вишлист с фото и ценами. Делись им с друзьями 🌷",
});
const me = await (await fetch(`https://api.telegram.org/bot${token}/getMe`)).json();
console.log(`\nBot: @${me.result?.username}. Set NEXT_PUBLIC_BOT_USERNAME=${me.result?.username}`);
