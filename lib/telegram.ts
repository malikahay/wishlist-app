import crypto from "node:crypto";

export type TgUser = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
};

const MAX_AGE_SEC = 60 * 60 * 24; // initData older than a day is rejected

/**
 * Validates Telegram Mini App initData (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
 * and returns the user. Throws if the signature is wrong.
 */
export function validateInitData(initData: string, botToken: string): TgUser {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) throw new Error("no hash");
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");
  if (
    expected.length !== hash.length ||
    !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hash))
  ) {
    throw new Error("bad signature");
  }

  const authDate = Number(params.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > MAX_AGE_SEC) throw new Error("expired");

  const user = JSON.parse(params.get("user") || "null");
  if (!user?.id) throw new Error("no user");
  return user;
}

const DEV_USER: TgUser = { id: 1, first_name: "Dev", username: "dev" };

/** Reads `Authorization: tma <initData>`; in local dev without Telegram falls back to a fake user. */
export function getUser(req: Request): TgUser | null {
  const auth = req.headers.get("authorization") || "";
  const initData = auth.startsWith("tma ") ? auth.slice(4) : "";
  const token = process.env.BOT_TOKEN;

  if (initData && token) {
    try {
      return validateInitData(initData, token);
    } catch {
      return null;
    }
  }
  if (process.env.NODE_ENV === "development") return DEV_USER;
  return null;
}

export async function tg(method: string, body: Record<string, unknown>) {
  const res = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) console.error(`telegram ${method} failed:`, data.description);
  return data;
}

export function displayName(u: Pick<TgUser, "first_name" | "last_name">) {
  return [u.first_name, u.last_name].filter(Boolean).join(" ");
}
