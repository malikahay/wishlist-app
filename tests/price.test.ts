import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePrice, totalsByCurrency } from "../lib/price.ts";

test("parses common price formats", () => {
  const cases: [string, number][] = [
    ["1 299,99", 1299.99],
    ["1.299,99", 1299.99],
    ["1,299.99", 1299.99],
    ["$1,999.00", 1999],
    ["49.90", 49.9],
    ["49,90 €", 49.9],
    ["12,500", 12500],
    ["1.299", 1299],
    ["500 000 сум", 500000],
    ["1.299.000", 1299000],
    ["0.999", 0.999],
    ["295", 295],
  ];
  for (const [raw, want] of cases) assert.equal(parsePrice(raw), want, raw);
});

test("rejects empty input", () => {
  assert.equal(parsePrice(""), null);
  assert.equal(parsePrice("цена по запросу"), null);
});

test("totals never mix currencies", () => {
  const t = totalsByCurrency([
    { price: "100", currency: "USD" },
    { price: "500 000", currency: "UZS" },
    { price: "49.90", currency: "usd" },
  ]);
  assert.equal(t.length, 2);
  assert.ok(t[0].includes("500"));
  assert.ok(t.some((s) => s.includes("149,9") && s.includes("$")));
});
