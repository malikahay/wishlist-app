/**
 * Price helpers shared by the Mini App.
 * Handles "1 299,99", "1.299,99" (EU), "1,299.99" (US), "49.90", "12,500", "1'299.00", "500 000 сум".
 */
export function parsePrice(raw: string | null | undefined): number | null {
  if (!raw) return null;
  let s = String(raw).replace(/[^\d.,]/g, "");
  if (!/\d/.test(s)) return null;
  s = s.replace(/^[.,]+|[.,]+$/g, "");

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot !== -1 && lastComma !== -1) {
    // both present: whichever comes last is the decimal separator
    const dec = lastDot > lastComma ? "." : ",";
    const thou = dec === "." ? "," : ".";
    s = s.split(thou).join("").replace(dec, ".");
  } else if (lastDot !== -1 || lastComma !== -1) {
    const sep = lastDot !== -1 ? "." : ",";
    const parts = s.split(sep);
    const tail = parts[parts.length - 1];
    // "1.299.000" or "12,500" → thousands; "49.90" / "1299,9" → decimal
    const thousands = parts.length > 2 || (tail.length === 3 && parts[0].length <= 3 && parts[0] !== "0");
    s = thousands ? parts.join("") : parts.slice(0, -1).join("") + "." + tail;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const SYMBOL: Record<string, string> = { RUB: "₽", USD: "$", EUR: "€", GBP: "£", KZT: "₸", UZS: "сум", UAH: "₴" };

export function formatAmount(n: number, currency: string | null) {
  const code = currency?.toUpperCase() ?? "";
  const sym = SYMBOL[code] ?? code;
  return `${n.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}${sym ? " " + sym : ""}`;
}

export function formatPrice(price: string | null, currency: string | null) {
  if (!price) return null;
  const n = parsePrice(price);
  return n === null ? price : formatAmount(n, currency);
}

/** Totals grouped by currency — never add dollars to sums. */
export function totalsByCurrency(items: { price: string | null; currency: string | null }[]) {
  const sums = new Map<string, number>();
  for (const i of items) {
    const n = parsePrice(i.price);
    if (n === null) continue;
    const cur = i.currency?.toUpperCase() || "";
    sums.set(cur, (sums.get(cur) ?? 0) + n);
  }
  return [...sums.entries()].sort((a, b) => b[1] - a[1]).map(([cur, n]) => formatAmount(n, cur || null));
}
