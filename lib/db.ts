import { Redis } from "@upstash/redis";
import { promises as fs } from "node:fs";
import crypto from "node:crypto";
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

export const MAX_ITEMS = 300;

export type ReserveResult = "ok" | "conflict" | "missing";

/**
 * Storage operations. Every read-modify-write on an item is atomic:
 * Redis runs it as a Lua script; the local file store serialises everything behind one mutex.
 * Items live one-per-field in a hash, so concurrent edits of different items never overwrite each other.
 */
interface Store {
  listItems(uid: number): Promise<Item[]>;
  addItem(uid: number, item: Item): Promise<boolean>;
  patchItem(uid: number, id: string, patch: Partial<Item>): Promise<Item | null>;
  deleteItem(uid: number, id: string): Promise<void>;
  setReservation(ownerId: number, id: string, viewerId: number, by: Item["reservedBy"]): Promise<ReserveResult>;
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSec?: number): Promise<void>;
  setIfAbsent(key: string, value: unknown, ttlSec: number): Promise<boolean>;
  del(key: string): Promise<void>;
  incr(key: string, ttlSec: number): Promise<number>;
}

const itemsKey = (uid: number) => `wl:it:${uid}`;
const legacyItemsKey = (uid: number) => `wl:items:${uid}`;

// ---------------------------------------------------------------- Redis

const LUA_ADD = `
if redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
return 1`;

// ARGV: itemId, JSON of fields to set, JSON array of field names to set to null
// (cjson drops nulls when decoding a patch, so clears travel separately)
const LUA_PATCH = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return false end
local obj = cjson.decode(raw)
for k, v in pairs(cjson.decode(ARGV[2])) do obj[k] = v end
for _, k in ipairs(cjson.decode(ARGV[3])) do obj[k] = cjson.null end
local out = cjson.encode(obj)
redis.call('HSET', KEYS[1], ARGV[1], out)
return out`;

// ARGV: itemId, viewerId, reservedBy JSON ('' = release)
const LUA_RESERVE = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return 'missing' end
local obj = cjson.decode(raw)
if obj.done then return 'missing' end
local r = obj.reservedBy
if r ~= nil and r ~= cjson.null and tostring(r.id) ~= ARGV[2] then return 'conflict' end
if ARGV[3] == '' then obj.reservedBy = cjson.null else obj.reservedBy = cjson.decode(ARGV[3]) end
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(obj))
return 'ok'`;

const LUA_INCR = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n`;

/** Upstash's Lua cjson drops null fields on round-trips; restore the item's full shape. */
function normalizeItem(i: Item | null): Item | null {
  if (!i || typeof i !== "object") return null;
  return {
    ...i,
    url: i.url ?? "",
    image: i.image ?? null,
    price: i.price ?? null,
    currency: i.currency ?? null,
    site: i.site ?? "",
    note: i.note ?? "",
    done: !!i.done,
    reservedBy: i.reservedBy ?? null,
  };
}

/** HGETALL without auto-deserialisation comes back as [field, value, field, value, …]. */
function flatToRecord(v: unknown): Record<string, string> {
  if (!v) return {};
  if (!Array.isArray(v)) return v as Record<string, string>;
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < v.length; i += 2) out[String(v[i])] = v[i + 1];
  return out;
}

function redisStore(): Store | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  // we (de)serialise ourselves so Lua scripts and TS see the same JSON strings
  const r = new Redis({ url, token, automaticDeserialization: false });
  const parse = <T>(v: unknown): T | null => {
    if (v == null) return null;
    if (typeof v !== "string") return v as T;
    try {
      return JSON.parse(v) as T;
    } catch {
      return v as T;
    }
  };
  const enc = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

  return {
    async listItems(uid) {
      let all = flatToRecord(await r.hgetall(itemsKey(uid)));
      if (Object.keys(all).length === 0) {
        // one-time migration from the old "whole array in one key" format
        const legacy = parse<Item[]>(await r.get(legacyItemsKey(uid)));
        if (Array.isArray(legacy) && legacy.length) {
          const fields = Object.fromEntries(legacy.map((i) => [i.id, JSON.stringify(i)]));
          await r.hset(itemsKey(uid), fields);
          await r.del(legacyItemsKey(uid));
          all = fields;
        }
      }
      return Object.values(all)
        .map((v) => normalizeItem(parse<Item>(v)))
        .filter((i): i is Item => !!i);
    },
    async addItem(uid, item) {
      return (await r.eval(LUA_ADD, [itemsKey(uid)], [item.id, JSON.stringify(item), String(MAX_ITEMS)])) === 1;
    },
    async patchItem(uid, id, patch) {
      const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null && v !== undefined));
      const clear = Object.entries(patch).filter(([, v]) => v === null).map(([k]) => k);
      return normalizeItem(parse<Item>(await r.eval(LUA_PATCH, [itemsKey(uid)], [id, JSON.stringify(set), JSON.stringify(clear)])));
    },
    async deleteItem(uid, id) {
      await r.hdel(itemsKey(uid), id);
    },
    async setReservation(ownerId, id, viewerId, by) {
      return (await r.eval(LUA_RESERVE, [itemsKey(ownerId)], [id, String(viewerId), by ? JSON.stringify(by) : ""])) as ReserveResult;
    },
    get: async (k) => parse(await r.get(k)),
    set: async (k, v, ttl) => {
      await (ttl ? r.set(k, enc(v), { ex: ttl }) : r.set(k, enc(v)));
    },
    setIfAbsent: async (k, v, ttl) => (await r.set(k, enc(v), { nx: true, ex: ttl })) === "OK",
    del: async (k) => {
      await r.del(k);
    },
    incr: async (k, ttl) => Number(await r.eval(LUA_INCR, [k], [String(ttl)])),
  };
}

// ---------------------------------------------------------------- local file (dev only)

function fileStore(): Store {
  const file = path.join(process.cwd(), ".data", "db.json");
  type Entry = { v: any; exp?: number };
  let db: Record<string, Entry> | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  /** Runs fn with exclusive access to the in-memory db, then persists it. */
  const tx = <T>(fn: (d: Record<string, Entry>) => T): Promise<T> => {
    const run = chain.then(async () => {
      if (!db) {
        try {
          db = JSON.parse(await fs.readFile(file, "utf8"));
        } catch {
          db = {};
        }
      }
      const now = Date.now();
      for (const [k, e] of Object.entries(db!)) if (e.exp && e.exp < now) delete db![k];
      const out = fn(db!);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(db));
      return out;
    });
    chain = run.catch(() => {});
    return run;
  };
  const hash = (d: Record<string, Entry>, uid: number): Record<string, Item> =>
    (d[itemsKey(uid)] ??= { v: {} }).v;

  return {
    listItems: (uid) => tx((d) => Object.values(hash(d, uid))),
    addItem: (uid, item) =>
      tx((d) => {
        const h = hash(d, uid);
        if (Object.keys(h).length >= MAX_ITEMS) return false;
        h[item.id] = item;
        return true;
      }),
    patchItem: (uid, id, patch) =>
      tx((d) => {
        const h = hash(d, uid);
        if (!h[id]) return null;
        h[id] = { ...h[id], ...patch };
        return h[id];
      }),
    deleteItem: (uid, id) =>
      tx((d) => {
        delete hash(d, uid)[id];
      }),
    setReservation: (ownerId, id, viewerId, by) =>
      tx((d): ReserveResult => {
        const it = hash(d, ownerId)[id];
        if (!it || it.done) return "missing";
        if (it.reservedBy && it.reservedBy.id !== viewerId) return "conflict";
        it.reservedBy = by ?? null;
        return "ok";
      }),
    get: (k) => tx((d) => d[k]?.v ?? null),
    set: (k, v, ttl) =>
      tx((d) => {
        d[k] = { v, exp: ttl ? Date.now() + ttl * 1000 : undefined };
      }),
    setIfAbsent: (k, v, ttl) =>
      tx((d) => {
        if (d[k]) return false;
        d[k] = { v, exp: Date.now() + ttl * 1000 };
        return true;
      }),
    del: (k) =>
      tx((d) => {
        delete d[k];
      }),
    incr: (k, ttl) =>
      tx((d) => {
        const e = (d[k] ??= { v: 0, exp: Date.now() + ttl * 1000 });
        e.v += 1;
        return e.v as number;
      }),
  };
}

function createStore(): Store {
  const r = redisStore();
  if (r) return r;
  if (process.env.VERCEL || process.env.NODE_ENV === "production") {
    // a file store on serverless silently loses data — fail loudly instead
    throw new Error("Redis is not configured (KV_REST_API_URL / KV_REST_API_TOKEN)");
  }
  return fileStore();
}

let _store: Store | null = null;
export const store = (): Store => (_store ??= createStore());

// ---------------------------------------------------------------- items

const byNewest = (a: Item, b: Item) => b.createdAt - a.createdAt;

export async function getItems(uid: number): Promise<Item[]> {
  return (await store().listItems(uid)).sort(byNewest);
}

export async function addItem(uid: number, item: Item): Promise<boolean> {
  return store().addItem(uid, item);
}

/** Owner edits. `reservedBy` can never be changed through here. */
export async function patchItem(uid: number, id: string, patch: Partial<Item>) {
  const { reservedBy, id: _id, createdAt, ...safe } = patch;
  return store().patchItem(uid, id, safe);
}

export async function deleteItem(uid: number, id: string) {
  await store().deleteItem(uid, id);
}

/** Idempotent: `reserve=true` claims (or keeps) the item for the viewer, `false` releases the viewer's own claim. */
export async function setReservation(ownerId: number, id: string, viewer: { id: number; name: string }, reserve: boolean) {
  return store().setReservation(ownerId, id, viewer.id, reserve ? viewer : null);
}

// ---------------------------------------------------------------- profiles & sharing

export async function getProfile(uid: number) {
  return store().get<Profile>(`wl:profile:${uid}`);
}

export async function saveProfile(p: Profile) {
  await store().set(`wl:profile:${p.id}`, p);
}

/** Random, revocable share token → owner id. Lists are reachable only through it, not by Telegram id. */
export async function getShareToken(uid: number, rotate = false): Promise<string> {
  const current = await store().get<string>(`wl:shareof:${uid}`);
  if (current && !rotate) return current;
  const token = crypto.randomBytes(12).toString("base64url");
  await store().set(`wl:share:${token}`, uid);
  await store().set(`wl:shareof:${uid}`, token);
  if (current) await store().del(`wl:share:${current}`);
  return token;
}

export async function ownerByToken(token: string): Promise<number | null> {
  if (!/^[\w-]{10,40}$/.test(token)) return null;
  const v = await store().get<number | string>(`wl:share:${token}`);
  return v == null ? null : Number(v);
}

// ---------------------------------------------------------------- misc keys

/** True the first time a key is seen within ttl — used for Telegram update de-duplication. */
export async function firstTime(key: string, ttlSec: number) {
  return store().setIfAbsent(key, 1, ttlSec);
}

export async function putTemp(key: string, value: unknown, ttlSec: number) {
  await store().set(key, value, ttlSec);
}

export async function takeTemp<T>(key: string): Promise<T | null> {
  const v = await store().get<T>(key);
  if (v != null) await store().del(key);
  return v;
}

export async function incrCounter(key: string, ttlSec: number) {
  return store().incr(key, ttlSec);
}

// ---------------------------------------------------------------- views

/** The owner never sees reservations — it's a surprise. */
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

// ---------------------------------------------------------------- images

/** Cropped product photos from screenshots, stored as base64 JPEG. */
export async function saveImage(jpeg: Buffer): Promise<string> {
  const id = crypto.randomUUID().replace(/-/g, "");
  await store().set(`wl:img:${id}`, jpeg.toString("base64"));
  return id;
}

export async function getImage(id: string): Promise<Buffer | null> {
  if (!/^[a-f0-9]{32}$/.test(id)) return null;
  const b64 = await store().get<string>(`wl:img:${id}`);
  return typeof b64 === "string" ? Buffer.from(b64, "base64") : null;
}
