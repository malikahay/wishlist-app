import { Redis } from "@upstash/redis";
import { promises as fs } from "node:fs";
import path from "node:path";

export type Item = {
  id: string;
  url: string;
  title: string;
  image: string | null;
  price: string | null;
  currency: string | null;
  site: string;
  note: string;
  done: boolean;
  createdAt: number;
  reservedBy?: { id: number; name: string } | null;
};

export type Profile = { id: number; name: string; username?: string; photo?: string };

/**
 * Minimal key/value store. Uses Upstash Redis when its env vars are present (production on Vercel),
 * otherwise a JSON file in .data/ so the app runs locally without any setup.
 */
interface Store {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
}

function redisStore(): Store | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const r = new Redis({ url, token });
  return {
    get: (k) => r.get(k),
    set: async (k, v) => {
      await r.set(k, v);
    },
  };
}

function fileStore(): Store {
  const file = path.join(process.cwd(), ".data", "db.json");
  let cache: Record<string, unknown> | null = null;
  const read = async () => {
    if (cache) return cache;
    try {
      cache = JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      cache = {};
    }
    return cache!;
  };
  return {
    get: async (k) => ((await read())[k] as any) ?? null,
    set: async (k, v) => {
      const db = await read();
      db[k] = v;
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(db, null, 2));
    },
  };
}

const store: Store = redisStore() ?? fileStore();

const itemsKey = (uid: number) => `wl:items:${uid}`;
const profileKey = (uid: number) => `wl:profile:${uid}`;

export async function getItems(uid: number): Promise<Item[]> {
  return (await store.get<Item[]>(itemsKey(uid))) ?? [];
}

export async function saveItems(uid: number, items: Item[]) {
  await store.set(itemsKey(uid), items);
}

export async function updateItems(uid: number, fn: (items: Item[]) => Item[]) {
  const next = fn(await getItems(uid));
  await saveItems(uid, next);
  return next;
}

export async function getProfile(uid: number) {
  return store.get<Profile>(profileKey(uid));
}

export async function saveProfile(p: Profile) {
  await store.set(profileKey(p.id), p);
}

/** The owner never sees who reserved what — it's a surprise. */
export function forOwner(items: Item[]) {
  return items.map(({ reservedBy, ...i }) => i);
}

/** Friends see whether an item is taken and whether it's taken by them. */
export function forGuest(items: Item[], viewerId: number) {
  return items
    .filter((i) => !i.done)
    .map(({ reservedBy, ...i }) => ({
      ...i,
      reserved: !!reservedBy,
      reservedByMe: reservedBy?.id === viewerId,
    }));
}

/** Cropped product photos from screenshots, stored as base64 JPEG. */
export async function saveImage(jpeg: Buffer): Promise<string> {
  const id = crypto.randomUUID().replace(/-/g, "");
  await store.set(`wl:img:${id}`, jpeg.toString("base64"));
  return id;
}

export async function getImage(id: string): Promise<Buffer | null> {
  if (!/^[a-f0-9]{32}$/.test(id)) return null;
  const b64 = await store.get<string>(`wl:img:${id}`);
  return b64 ? Buffer.from(b64, "base64") : null;
}
