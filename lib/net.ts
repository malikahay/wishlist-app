import dns from "node:dns";
import net from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

/**
 * Outbound HTTP for user-supplied URLs (shop pages, product images).
 *
 * - Every connection's resolved IP is checked inside the socket `lookup`, so DNS rebinding and
 *   hostnames that resolve to private ranges are refused at connect time, not just by a string check.
 * - Redirects are followed manually and each hop is re-validated.
 * - Response bodies are capped in size, and the whole request (headers + body) shares one deadline.
 */

export class UnsafeUrlError extends Error {}

/** fetch wraps connect-time failures; dig out our own block reason if that's what happened. */
export function unsafeCause(e: unknown): UnsafeUrlError | null {
  for (let c: any = e, depth = 0; c && depth < 5; c = c.cause, depth++) {
    if (c instanceof UnsafeUrlError) return c;
  }
  return null;
}

/** True for any address that is not a normal public unicast address. */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) || // 192.0.0.0/24 + 192.0.2.0/24 test-net
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51) ||
      (a === 203 && b === 0) ||
      a >= 224 // multicast + reserved + broadcast
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
    if (v === "::" || v === "::1") return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(v)) {
      // ::ffff:7f00:1 form
      const [hi, lo] = v.slice(7).split(":").map((h) => parseInt(h, 16));
      return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    const first = parseInt(v.split(":")[0] || "0", 16);
    return (
      (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
      (first & 0xffc0) === 0xfe80 || // fe80::/10 link local
      (first & 0xff00) === 0xff00 || // multicast
      v.startsWith("64:ff9b:") || // NAT64
      v.startsWith("2001:db8:") || // documentation
      v.startsWith("2002:") // 6to4 can embed private v4
    );
  }
  return true; // not an IP at all — refuse
}

/** Syntactic checks on a URL before any network activity. */
export function assertPublicUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UnsafeUrlError("Некорректная ссылка");
  }
  if (!["http:", "https:"].includes(u.protocol)) throw new UnsafeUrlError("Нужна ссылка http(s)");
  if (u.username || u.password) throw new UnsafeUrlError("Ссылка с логином не поддерживается");
  if (u.port && !["80", "443"].includes(u.port)) throw new UnsafeUrlError("Нестандартный порт не поддерживается");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (net.isIP(host) && isPrivateIp(host)) throw new UnsafeUrlError("Эта ссылка недоступна");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new UnsafeUrlError("Эта ссылка недоступна");
  }
  return u;
}

const safeLookup: typeof dns.lookup = ((hostname: string, options: any, callback: any) => {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  dns.lookup(hostname, { ...options, all: true }, (err, addresses: dns.LookupAddress[]) => {
    if (err) return callback(err);
    const bad = addresses.find((a) => isPrivateIp(a.address));
    if (bad || addresses.length === 0) {
      return callback(new UnsafeUrlError(`Blocked private address for ${hostname}`));
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}) as any;

const agent = new Agent({ connect: { lookup: safeLookup, timeout: 8_000 } });

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
};

export type SafeResponse = {
  ok: boolean;
  status: number;
  url: string; // final URL after redirects
  contentType: string;
  body: Buffer;
};

/**
 * Fetches a user-supplied URL with SSRF protection, a byte cap, and one deadline for the whole exchange.
 * Throws UnsafeUrlError for blocked targets, and a normal Error on timeouts/oversize bodies.
 */
export async function safeFetch(
  raw: string,
  opts: { headers?: Record<string, string>; maxBytes?: number; timeoutMs?: number; maxRedirects?: number } = {},
): Promise<SafeResponse> {
  const { maxBytes = 3_000_000, timeoutMs = 10_000, maxRedirects = 5 } = opts;
  const signal = AbortSignal.timeout(timeoutMs);
  let url = assertPublicUrl(raw);

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await undiciFetch(url.toString(), {
      headers: { ...BROWSER_HEADERS, ...(opts.headers || {}) },
      redirect: "manual",
      dispatcher: agent,
      signal,
    });

    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      await res.body?.cancel();
      url = assertPublicUrl(new URL(res.headers.get("location")!, url).toString());
      continue;
    }

    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > maxBytes) {
      await res.body?.cancel();
      throw new Error("response too large");
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (res.body) {
      for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > maxBytes) {
          // HTML pages: keep what we have (meta tags live in <head>); binary: refuse
          if (opts.headers?.Accept?.startsWith("image")) throw new Error("response too large");
          break;
        }
        chunks.push(chunk);
      }
    }
    return {
      ok: res.ok,
      status: res.status,
      url: url.toString(),
      contentType: res.headers.get("content-type") || "",
      body: Buffer.concat(chunks),
    };
  }
  throw new Error("too many redirects");
}
