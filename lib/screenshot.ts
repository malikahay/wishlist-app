import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { getVercelOidcToken } from "@vercel/oidc";
import sharp from "sharp";
import { z } from "zod";
import { saveImage } from "./db";

/**
 * Reads a product screenshot with a vision model (GLM via Z.ai, Claude as fallback): extracts title/price/color/size and locates the product photo,
 * which is then cropped out and stored so the card shows only the item, not the whole screenshot.
 */

const Box = z.object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number() });

const Extraction = z.object({
  is_product: z.boolean().describe("true if the screenshot shows a product page/card from a shop"),
  title: z.string().describe("Product name as shown, without brand duplication; empty if unknown"),
  brand: z.string().nullable(),
  price: z.number().nullable().describe("Current price the buyer pays (sale price if discounted)"),
  currency: z.string().nullable().describe("ISO 4217 code, e.g. USD, RUB, UZS, EUR"),
  color: z.string().nullable().describe("Selected/visible color, in Russian"),
  size: z.string().nullable().describe("Selected size if visibly chosen"),
  store: z.string().nullable().describe("Shop name or domain if visible"),
  product_photo: Box.nullable().describe(
    "Pixel bounding box of the main product photo only (no text, buttons or prices), in the given image size",
  ),
});

export type ScreenshotResult = {
  title: string;
  price: string | null;
  currency: string | null;
  note: string;
  site: string;
  image: string | null; // "img:<id>" stored crop
};

export const MAX_UPLOAD_BYTES = 6_000_000;
const MAX_INPUT_PIXELS = 40_000_000; // e.g. 6000×6600 — guards against decompression bombs
const TOTAL_DEADLINE_MS = 75_000; // GLM attempts + Claude fallback together
const MAX_SIDE = 1568; // larger images get downscaled by the API anyway; keeps coordinates in our own pixel space

async function client() {
  if (process.env.ANTHROPIC_API_KEY) return { c: new Anthropic(), model: "claude-opus-5-5" };
  // On Vercel: route through AI Gateway, authenticated by the deployment's OIDC token (no extra key).
  const apiKey = process.env.AI_GATEWAY_API_KEY || (await getVercelOidcToken());
  return {
    c: new Anthropic({ apiKey, baseURL: "https://ai-gateway.vercel.sh" }),
    model: "anthropic/claude-opus-5.5",
  };
}

type Extracted = z.infer<typeof Extraction>;

const PROMPT = (w: number, h: number) =>
  `This is a screenshot from an online shop, ${w}×${h} px. ` +
  "Extract the product data for a wishlist card. Use only what is visible; leave fields null if not shown. " +
  "For product_photo, give a tight box around the main product image itself (the item, its photo area), " +
  "excluding UI text, prices, buttons, and thumbnails.";

/** Claude Opus 5.5 — directly with ANTHROPIC_API_KEY, otherwise via Vercel AI Gateway (OIDC). Box in pixels. */
async function extractWithClaude(jpeg: Buffer, w: number, h: number, timeoutMs: number): Promise<Extracted | null> {
  const { c, model } = await client();
  const res = await c.messages.parse({
    model,
    max_tokens: 4000,
    output_config: { effort: "low", format: zodOutputFormat(Extraction) },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } },
          { type: "text", text: PROMPT(w, h) },
        ],
      },
    ],
  }, { timeout: timeoutMs, maxRetries: 0 });
  if (res.stop_reason === "refusal") return null;
  return res.parsed_output ?? null;
}

/**
 * GLM vision via Z.ai (OpenAI-compatible). It returns boxes as [xmin,ymin,xmax,ymax]; the docs don't state the
 * scale, so we ask for 0–1000 and also accept pixels if every value fits the image but some exceed 1000.
 */
async function extractWithGlm(jpeg: Buffer, w: number, h: number, deadline: number): Promise<Extracted | null> {
  const prompt =
    PROMPT(w, h) +
    "\n\nAnswer with ONLY a JSON object, no markdown, with keys: " +
    'is_product (boolean), title (string), brand (string|null), price (number|null, the price the buyer pays now), ' +
    'currency (ISO 4217 code|null), color (string|null, in Russian), size (string|null, only if visibly selected), ' +
    'store (string|null), product_photo (array [xmin,ymin,xmax,ymax] with coordinates normalized to 0-1000, or null).';
  const call = (model: string, thinking: boolean) => fetch("https://api.z.ai/api/paas/v4/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.ZAI_API_KEY}`,
      "Content-Type": "application/json",
      "Accept-Language": "en-US,en",
    },
    body: JSON.stringify({
      model,
      ...(thinking ? {} : { thinking: { type: "disabled" } }),
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(Math.max(1_000, deadline - Date.now())),
  });
  // thinking off is faster; if this model doesn't allow it, retry with its default
  // free flash model first, paid one if it isn't available on this account
  const models = process.env.GLM_MODEL ? [process.env.GLM_MODEL] : ["glm-4.6v-flash", "glm-4.6v"];
  let data: any = null;
  let lastErr = "";
  for (const model of models) {
    let res = await call(model, false);
    if (res.status === 400) res = await call(model, true);
    data = await res.json().catch(() => null);
    if (res.ok) {
      console.log("glm model used:", model);
      break;
    }
    lastErr = `GLM ${model} ${res.status}: ${JSON.stringify(data?.error ?? data).slice(0, 300)}`;
    console.error(lastErr);
    data = null;
  }
  if (!data) throw new Error(lastErr);
  const text: string = data?.choices?.[0]?.message?.content ?? "";
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let raw: any;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error(`GLM returned non-JSON: ${text.slice(0, 200)}`);
  }
  console.log("glm extraction", JSON.stringify(raw).slice(0, 400));

  let box: Extracted["product_photo"] = null;
  const b = Array.isArray(raw.product_photo) ? raw.product_photo.flat().map(Number) : null;
  if (b && b.length === 4 && b.every(Number.isFinite)) {
    const [x0, y0, x1, y1] = b;
    const pixels = Math.max(x0, x1) > 1000 || Math.max(y0, y1) > 1000;
    const sx = pixels ? 1 : w / 1000;
    const sy = pixels ? 1 : h / 1000;
    box = { left: x0 * sx, top: y0 * sy, right: x1 * sx, bottom: y1 * sy };
  }
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const num = Number(raw.price);
  return {
    is_product: raw.is_product !== false,
    title: str(raw.title) ?? "",
    brand: str(raw.brand),
    price: raw.price != null && Number.isFinite(num) ? num : null,
    currency: str(raw.currency),
    color: str(raw.color),
    size: str(raw.size),
    store: str(raw.store),
    product_photo: box,
  };
}

async function extract(jpeg: Buffer, w: number, h: number): Promise<Extracted | null> {
  const deadline = Date.now() + TOTAL_DEADLINE_MS;
  if (process.env.ZAI_API_KEY) {
    try {
      return await extractWithGlm(jpeg, w, h, deadline - 20_000);
    } catch (e) {
      console.error("glm failed, falling back to Claude", e);
    }
  }
  const left = deadline - Date.now();
  if (left < 8_000) throw new Error("screenshot deadline exceeded");
  return extractWithClaude(jpeg, w, h, left);
}

export async function analyzeScreenshot(input: Buffer): Promise<ScreenshotResult | null> {
  if (input.byteLength > MAX_UPLOAD_BYTES) throw new Error("image too large");
  const base = sharp(input, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS }).rotate();
  const { data: jpeg, info } = await base
    .clone()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer({ resolveWithObject: true });

  const x = await extract(jpeg, info.width, info.height);
  if (!x || !x.is_product) return null;

  let image: string | null = null;
  const b = x.product_photo;
  if (b) {
    const left = clamp(Math.floor(Math.min(b.left, b.right)), 0, info.width - 1);
    const top = clamp(Math.floor(Math.min(b.top, b.bottom)), 0, info.height - 1);
    const width = clamp(Math.ceil(Math.abs(b.right - b.left)), 1, info.width - left);
    const height = clamp(Math.ceil(Math.abs(b.bottom - b.top)), 1, info.height - top);
    // ignore degenerate boxes (tiny, or basically the whole screen)
    const area = (width * height) / (info.width * info.height);
    if (width > 60 && height > 60 && area < 0.95) {
      const crop = await sharp(jpeg)
        .extract({ left, top, width, height })
        .resize({ width: 900, height: 900, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 84 })
        .toBuffer();
      image = `img:${await saveImage(crop)}`;
    }
  }

  const title = [x.brand, x.title].filter((s) => s && s.trim()).join(" ").trim();
  const note = [x.color && `Цвет: ${x.color}`, x.size && `Размер: ${x.size}`].filter(Boolean).join(" · ");
  return {
    title: title || "Без названия",
    price: x.price != null ? String(x.price) : null,
    currency: x.currency,
    note,
    site: x.store || "",
    image,
  };
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}
