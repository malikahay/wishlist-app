import * as cheerio from "cheerio";
import { assertPublicUrl, safeFetch, unsafeCause, UnsafeUrlError } from "./net";
import { takeGlobal } from "./limits";

export type Preview = {
  url: string;
  title: string;
  image: string | null;
  price: string | null;
  currency: string | null;
  site: string;
  description: string | null;
};

export { assertPublicUrl } from "./net";
function abs(src: string | undefined | null, base: string): string | null {
  if (!src) return null;
  try {
    return new URL(src.trim(), base).toString();
  } catch {
    return null;
  }
}

function first<T>(...vals: (T | null | undefined | "")[]): T | null {
  for (const v of vals) if (v !== null && v !== undefined && v !== "") return v as T;
  return null;
}

/** Walks JSON-LD blocks (incl. @graph and arrays) looking for a Product node. */
function findProduct(node: unknown): Record<string, any> | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = findProduct(n);
      if (r) return r;
    }
    return null;
  }
  const obj = node as Record<string, any>;
  const type = obj["@type"];
  const types = Array.isArray(type) ? type : [type];
  if (types.some((t) => typeof t === "string" && /product/i.test(t))) return obj;
  if (obj["@graph"]) return findProduct(obj["@graph"]);
  return null;
}

function ldImage(img: unknown): string | null {
  if (!img) return null;
  if (typeof img === "string") return img;
  if (Array.isArray(img)) return ldImage(img[0]);
  if (typeof img === "object") return (img as any).url || (img as any).contentUrl || null;
  return null;
}

function ldOffer(offers: unknown): { price: string | null; currency: string | null } {
  if (!offers) return { price: null, currency: null };
  const o: any = Array.isArray(offers) ? offers[0] : offers;
  const price = first<string>(
    o?.price?.toString(),
    o?.lowPrice?.toString(),
    o?.priceSpecification?.price?.toString(),
  );
  const currency = first<string>(o?.priceCurrency, o?.priceSpecification?.priceCurrency);
  return { price, currency };
}

export function parseHtml(html: string, pageUrl: string): Preview {
  const $ = cheerio.load(html);
  const meta = (...keys: string[]) => {
    for (const k of keys) {
      const v =
        $(`meta[property="${k}"]`).attr("content") ||
        $(`meta[name="${k}"]`).attr("content") ||
        $(`meta[itemprop="${k}"]`).attr("content");
      if (v && v.trim()) return v.trim();
    }
    return null;
  };

  let product: Record<string, any> | null = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (product) return;
    try {
      product = findProduct(JSON.parse($(el).contents().text()));
    } catch {
      /* malformed JSON-LD — ignore */
    }
  });
  const p = product as Record<string, any> | null;
  const offer = ldOffer(p?.offers);

  const title = first<string>(
    p?.name,
    meta("og:title", "twitter:title"),
    $("h1").first().text().trim(),
    $("title").text().trim(),
  );

  const image = first<string>(
    abs(ldImage(p?.image), pageUrl),
    abs(meta("og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src", "image"), pageUrl),
    abs($('link[rel="image_src"]').attr("href"), pageUrl),
    abs($('[itemprop="image"]').attr("src"), pageUrl),
    // Amazon and similar shops without og:image
    abs($("#landingImage").attr("data-old-hires") || $("#landingImage").attr("src"), pageUrl),
    abs($("#imgTagWrapperId img, #main-image").first().attr("src"), pageUrl),
    // last resort: first image that looks like a product photo
    abs(
      $("img")
        .filter((_, el) => /product|gallery|main|zoom|hero/i.test(($(el).attr("class") || "") + ($(el).attr("id") || "")))
        .first()
        .attr("src"),
      pageUrl,
    ),
  );

  const price = first<string>(
    offer.price,
    meta("product:price:amount", "og:price:amount", "price"),
    $('[itemprop="price"]').attr("content"),
    $('[itemprop="price"]').first().text().trim(),
    $(".a-price .a-offscreen").first().text().trim(),
  );

  const symbols: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP", "₽": "RUB", "₸": "KZT", "₴": "UAH" };
  const currency = first<string>(
    offer.currency,
    meta("product:price:currency", "og:price:currency", "priceCurrency"),
    $('[itemprop="priceCurrency"]').attr("content"),
    price ? symbols[Object.keys(symbols).find((s) => price.includes(s)) ?? ""] : null,
  );

  const host = new URL(pageUrl).hostname.replace(/^www\./, "");

  return {
    url: pageUrl,
    title: (title || host).replace(/\s+/g, " ").slice(0, 200),
    image,
    price: price ? price.replace(/\s+/g, " ").trim() : null,
    currency,
    site: first<string>(meta("og:site_name"), host) as string,
    description: first<string>(
      typeof p?.description === "string" ? p.description : null,
      meta("og:description", "description"),
    )?.slice(0, 300) ?? null,
  };
}

/** Builds a readable title from the URL itself, e.g. /coach-bella-medium-leather-shoulder-bag → "Coach Bella Medium Leather Shoulder Bag". */
export function titleFromUrl(u: URL): string | null {
  const skip = /^(p|dp|product|products|shop|item|catalog|ru|en|us|[a-z]{2}-[a-z]{2})$/i;
  const segs = u.pathname
    .split("/")
    .map((s) => decodeURIComponent(s).replace(/\.(html?|php|aspx?)$/i, ""))
    .filter((s) => s && !skip.test(s) && /[a-zа-яё]{3,}/i.test(s) && /[-_]/.test(s));
  const best = segs.sort((a, b) => b.length - a.length)[0];
  if (!best) return null;
  const words = best
    .split(/[-_+]+/)
    .filter((w) => w && !/^[a-z]*\d[\da-z]*$/i.test(w)); // drop SKU-like tokens
  if (words.length < 2) return null;
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

export type ScrapeResult = Preview & { partial?: boolean; warning?: string };

type Attempt = { html: string; finalUrl: string } | { error: string; status?: number };

const TOTAL_DEADLINE_MS = 45_000; // whole chain: direct + both ScrapingBee tiers

async function direct(url: string, timeoutMs: number): Promise<Attempt> {
  try {
    const res = await safeFetch(url, { timeoutMs: Math.min(timeoutMs, 12_000), maxBytes: 3_000_000 });
    if (!res.ok) return { error: `HTTP ${res.status}`, status: res.status };
    return { html: res.body.toString("utf8"), finalUrl: res.url };
  } catch (e) {
    if (unsafeCause(e)) throw new UnsafeUrlError("Эта ссылка недоступна");
    return { error: e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network" };
  }
}

/**
 * ScrapingBee renders the page through residential proxies, which gets past most bot walls (Akamai etc).
 * Tier 1 = premium proxy (~10 credits), tier 2 = stealth proxy (~75 credits) for the hardest sites.
 * Capped by a global daily budget so one user can't burn the account's credits.
 */
async function viaScrapingBee(url: string, tier: "premium" | "stealth", timeoutMs: number): Promise<Attempt> {
  const key = process.env.SCRAPINGBEE_API_KEY;
  if (!key) return { error: "no key" };
  const budget = Number(process.env.SCRAPINGBEE_DAILY_LIMIT || 200);
  if (!(await takeGlobal("scrapingbee", budget, 86_400))) return { error: "daily budget exhausted" };
  const q = new URLSearchParams({ api_key: key, url, block_resources: "true" });
  if (tier === "premium") {
    q.set("premium_proxy", "true");
    q.set("render_js", "false");
  } else {
    q.set("stealth_proxy", "true");
    q.set("render_js", "true");
  }
  try {
    const res = await fetch(`https://app.scrapingbee.com/api/v1/?${q}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { error: `scrapingbee ${res.status}`, status: res.status };
    const finalUrl = res.headers.get("spb-resolved-url") || url;
    return { html: (await res.text()).slice(0, 3_000_000), finalUrl };
  } catch {
    return { error: "scrapingbee timeout" };
  }
}

const useful = (p: Preview | null) => !!p && !!(p.image || p.price);

/** Fetches a product page; if the shop blocks us, retries via ScrapingBee, and finally falls back to the URL itself. */
export async function scrape(raw: string): Promise<ScrapeResult> {
  let input = raw.trim();
  if (!/^https?:\/\//i.test(input)) input = "https://" + input;
  const target = assertPublicUrl(input);
  const url = target.toString();
  const host = target.hostname.replace(/^www\./, "");
  const slug = titleFromUrl(target);
  const deadline = Date.now() + TOTAL_DEADLINE_MS;
  const left = () => deadline - Date.now();

  const parse = (a: Attempt): Preview | null => {
    if (!("html" in a)) return null;
    const p = parseHtml(a.html, a.finalUrl);
    // a generic page title (e.g. a redirect to a category) is worse than the URL slug
    if (slug && (!p.title || p.title === host || p.title.length < 12) && !p.image) p.title = slug;
    return p;
  };

  let best = parse(await direct(url, left()));
  if (!useful(best) && process.env.SCRAPINGBEE_API_KEY) {
    for (const tier of ["premium", "stealth"] as const) {
      if (left() < 5_000) break;
      const p = parse(await viaScrapingBee(url, tier, left()));
      if (p && (!best || useful(p))) best = p;
      if (useful(best)) break;
    }
  }

  if (useful(best)) return best!;
  const base: Preview = best ?? {
    url,
    title: slug || host,
    image: null,
    price: null,
    currency: null,
    site: host,
    description: null,
  };
  return {
    ...base,
    partial: true,
    warning: `${host} не отдал фото и цену. Впиши цену, а фото — пришли скриншот, я его распознаю 📸`,
  };
}
