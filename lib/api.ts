import { NextResponse } from "next/server";
import { getUser, displayName, type TgUser } from "./telegram";
import { saveProfile } from "./db";

export const unauthorized = () => NextResponse.json({ error: "Открой приложение из Telegram" }, { status: 401 });

/** Resolves the Telegram user and keeps their public profile fresh. */
export async function requireUser(req: Request): Promise<TgUser | null> {
  const u = getUser(req);
  if (u) {
    await saveProfile({ id: u.id, name: displayName(u), username: u.username, photo: u.photo_url });
  }
  return u;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const opt = (v: unknown, max: number) => str(v, max) || null;

export function cleanItemInput(b: Record<string, unknown>) {
  return {
    url: str(b.url, 2000),
    title: str(b.title, 200),
    image: opt(b.image, 2000),
    price: opt(b.price, 40),
    currency: opt(b.currency, 8),
    site: str(b.site, 100),
    note: str(b.note, 300),
  };
}
