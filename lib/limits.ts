import { incrCounter } from "./db";

/**
 * Fixed-window counters in Redis. Each call consumes one unit; returns false once the window is full.
 * Limits are deliberately conservative for a personal wishlist and can be raised via env.
 */
async function take(key: string, limit: number, windowSec: number): Promise<boolean> {
  const bucket = Math.floor(Date.now() / 1000 / windowSec);
  return (await incrCounter(`rl:${key}:${bucket}`, windowSec + 5)) <= limit;
}

const env = (name: string, fallback: number) => Number(process.env[name] || fallback);

export type Kind = "preview" | "screenshot";

const PER_USER: Record<Kind, { minute: number; day: number }> = {
  preview: { minute: 10, day: env("LIMIT_PREVIEW_PER_DAY", 100) },
  screenshot: { minute: 4, day: env("LIMIT_SCREENSHOT_PER_DAY", 20) },
};
const GLOBAL_DAY: Record<Kind, number> = {
  preview: env("LIMIT_PREVIEW_GLOBAL_PER_DAY", 3000),
  screenshot: env("LIMIT_SCREENSHOT_GLOBAL_PER_DAY", 300),
};

/** Per-user minute + day quota, then a global daily budget across all users. */
export async function allowUser(kind: Kind, uid: number): Promise<boolean> {
  const l = PER_USER[kind];
  return (
    (await take(`${kind}:u${uid}:m`, l.minute, 60)) &&
    (await take(`${kind}:u${uid}:d`, l.day, 86_400)) &&
    (await take(`${kind}:all:d`, GLOBAL_DAY[kind], 86_400))
  );
}

/** Global daily budget for a paid upstream (e.g. ScrapingBee credits). */
export async function takeGlobal(name: string, limit: number, windowSec: number) {
  return take(`${name}:all`, limit, windowSec);
}

/** Per-IP limit for unauthenticated endpoints (the image proxy). */
export async function allowIp(req: Request, name: string, perMinute: number) {
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  return take(`${name}:ip:${ip}`, perMinute, 60);
}

export const LIMIT_MESSAGE = "Слишком много запросов — попробуй чуть позже 🙏";
