"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Item = {
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
  reserved?: boolean;
  reservedByMe?: boolean;
};

type Draft = Pick<Item, "url" | "title" | "image" | "price" | "currency" | "site" | "note"> & {
  editingId?: string;
  warning?: string;
};

type Owner = { id: number; name: string; username?: string; photo?: string };

declare global {
  interface Window {
    Telegram?: { WebApp: any };
  }
}

const BOT = process.env.NEXT_PUBLIC_BOT_USERNAME || "";
const PASTELS = ["var(--pink)", "var(--mint)", "var(--lavender)", "var(--peach)", "var(--sky)", "var(--butter)"];
const CURRENCY: Record<string, string> = { RUB: "₽", USD: "$", EUR: "€", GBP: "£", KZT: "₸", UZS: "сум", UAH: "₴" };

const webApp = () => (typeof window !== "undefined" ? window.Telegram?.WebApp : undefined);
const haptic = (kind: "light" | "success" | "error") => {
  const h = webApp()?.HapticFeedback;
  if (!h) return;
  kind === "light" ? h.impactOccurred("light") : h.notificationOccurred(kind);
};

function colorFor(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PASTELS[h % PASTELS.length];
}

function toNumber(price: string | null): number | null {
  if (!price) return null;
  let s = price.replace(/[^\d.,]/g, "");
  s = s.includes(".") && s.includes(",") ? s.replace(/,/g, "") : s.replace(",", ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function formatPrice(price: string | null, currency: string | null) {
  if (!price) return null;
  const n = toNumber(price);
  const sym = currency ? CURRENCY[currency.toUpperCase()] ?? currency : "";
  if (n === null) return price;
  return `${n.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}${sym ? " " + sym : ""}`;
}

const imgSrc = (url: string | null) => (url ? `/api/image?url=${encodeURIComponent(url)}` : null);

function plural(n: number, [one, few, many]: [string, string, string]) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `tma ${webApp()?.initData || ""}`,
      ...(init.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "Ошибка"), { status: res.status });
  return data;
}

export default function Home() {
  const [me, setMe] = useState<{ id: number; name: string } | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [guest, setGuest] = useState<{ owner: Owner; items: Item[] } | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "outside">("loading");
  const [link, setLink] = useState("");
  const [fetching, setFetching] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [filter, setFilter] = useState<"wish" | "done">("wish");
  const [toast, setToast] = useState<string | null>(null);

  const flash = (t: string) => {
    setToast(t);
    setTimeout(() => setToast(null), 2200);
  };

  // ---------- boot ----------
  useEffect(() => {
    const tg = webApp();
    if (tg) {
      tg.ready();
      tg.expand();
      try {
        tg.setHeaderColor("#fbf8f4");
        tg.setBackgroundColor("#fbf8f4");
        tg.disableVerticalSwipes?.();
      } catch {}
    }
    const startParam: string | undefined =
      tg?.initDataUnsafe?.start_param || new URLSearchParams(location.search).get("startapp") || undefined;

    (async () => {
      try {
        const data = await api("/api/me");
        setMe(data.user);
        setItems(data.items);
        if (startParam && /^\d+$/.test(startParam) && Number(startParam) !== data.user.id) {
          setGuest(await api(`/api/lists/${startParam}`));
        }
        setStatus("ready");
      } catch (e: any) {
        if (e.status === 401) setStatus("outside");
        else {
          setError(e.message);
          setStatus("ready");
        }
      }
    })();
  }, []);

  // ---------- own list actions ----------
  async function fetchPreview(e?: React.FormEvent) {
    e?.preventDefault();
    const url = link.trim();
    if (!url) return;
    setFetching(true);
    setError(null);
    setDraft(null);
    try {
      const data = await api(`/api/preview?url=${encodeURIComponent(url)}`);
      setDraft({ ...data, note: "" });
      haptic("light");
    } catch (e: any) {
      setError(e.message);
      haptic("error");
    } finally {
      setFetching(false);
    }
  }

  async function uploadScreenshot(file: File) {
    setReading(true);
    setError(null);
    setDraft(null);
    try {
      const blob = await shrink(file);
      const fd = new FormData();
      fd.append("file", blob, "shot.jpg");
      const res = await fetch("/api/screenshot", {
        method: "POST",
        headers: { Authorization: `tma ${webApp()?.initData || ""}` },
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Не получилось прочитать скриншот");
      setDraft({ ...data, url: link.trim() || data.url });
      haptic("success");
    } catch (e: any) {
      setError(e.message);
      haptic("error");
    } finally {
      setReading(false);
    }
  }

  const save = useCallback(async () => {
    if (!draft) return;
    const { editingId, warning, ...fields } = draft;
    try {
      const data = editingId
        ? await api(`/api/items/${editingId}`, { method: "PATCH", body: JSON.stringify({ fields }) })
        : await api("/api/items", { method: "POST", body: JSON.stringify(fields) });
      setItems(data.items);
      setDraft(null);
      setLink("");
      setError(null);
      setFilter("wish");
      haptic("success");
      flash(editingId ? "Сохранено" : "Добавлено в вишлист ✨");
    } catch (e: any) {
      setError(e.message);
      haptic("error");
    }
  }, [draft]);

  async function toggleDone(item: Item) {
    haptic("light");
    setItems((p) => p.map((i) => (i.id === item.id ? { ...i, done: !i.done } : i)));
    const data = await api(`/api/items/${item.id}`, { method: "PATCH", body: JSON.stringify({ done: !item.done }) });
    setItems(data.items);
  }

  function remove(item: Item) {
    const run = async () => {
      setItems((p) => p.filter((i) => i.id !== item.id));
      const data = await api(`/api/items/${item.id}`, { method: "DELETE" });
      setItems(data.items);
    };
    const tg = webApp();
    if (tg?.showConfirm && tg.initData) tg.showConfirm(`Удалить «${item.title}»?`, (ok: boolean) => ok && run());
    else if (confirm(`Удалить «${item.title}»?`)) run();
  }

  function share() {
    if (!me) return;
    const url = BOT ? `https://t.me/${BOT}?startapp=${me.id}` : `${location.origin}/?startapp=${me.id}`;
    const tg = webApp();
    if (tg?.initData) {
      tg.openTelegramLink(
        `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent("Мой вишлист 🎁")}`,
      );
    } else {
      navigator.clipboard?.writeText(url);
      flash("Ссылка скопирована");
    }
  }

  // ---------- guest actions ----------
  async function reserve(item: Item) {
    if (!guest) return;
    try {
      const data = await api(`/api/lists/${guest.owner.id}/reserve`, {
        method: "POST",
        body: JSON.stringify({ itemId: item.id }),
      });
      setGuest({ ...guest, items: data.items });
      haptic("success");
      flash(item.reservedByMe ? "Бронь снята" : "Забронировано — это секрет 🤫");
    } catch (e: any) {
      haptic("error");
      flash(e.message);
    }
  }

  // ---------- Telegram native buttons ----------
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    const tg = webApp();
    if (!tg?.initData) return;
    const main = tg.MainButton;
    const back = tg.BackButton;
    const onMain = () => saveRef.current();
    const onBack = () => (draft ? setDraft(null) : setGuest(null));

    if (draft) {
      main.setParams({ text: draft.editingId ? "Сохранить" : "Добавить в вишлист", color: "#c9a7e8", text_color: "#ffffff" });
      main.show();
      main.onClick(onMain);
    } else main.hide();

    if (draft || guest) {
      back.show();
      back.onClick(onBack);
    } else back.hide();

    return () => {
      main.offClick(onMain);
      back.offClick(onBack);
    };
  }, [draft, guest]);

  const inTelegram = !!webApp()?.initData;

  const visible = useMemo(() => items.filter((i) => (filter === "done" ? i.done : !i.done)), [items, filter]);

  const total = useMemo(() => {
    const open = items.filter((i) => !i.done);
    const sum = open.reduce((s, i) => s + (toNumber(i.price) ?? 0), 0);
    const cur = open.find((i) => i.currency)?.currency ?? null;
    return { count: open.length, sum: sum ? formatPrice(String(sum), cur) : null };
  }, [items]);

  // ---------- render ----------
  if (status === "loading") {
    return (
      <main className="wrap center">
        <span className="spinner big-spin" />
      </main>
    );
  }

  if (status === "outside") {
    return (
      <main className="wrap center">
        <div className="empty-state">
          <div className="big">🌷</div>
          <p>Вишлист работает внутри Telegram</p>
          {BOT && (
            <a className="btn" href={`https://t.me/${BOT}`}>
              Открыть @{BOT}
            </a>
          )}
        </div>
      </main>
    );
  }

  if (guest) {
    return (
      <main className="wrap">
        <header className="header">
          <div>
            <p className="eyebrow">вишлист</p>
            <h1>
              {guest.owner.name}
              <span>.</span>
            </h1>
            <p>Забронируй подарок — {guest.owner.name.split(" ")[0]} не узнает, кто это 🤫</p>
          </div>
        </header>
        {!inTelegram && (
          <button className="btn ghost" onClick={() => setGuest(null)}>
            ← Мой вишлист
          </button>
        )}
        {guest.items.length === 0 ? (
          <div className="empty-state" style={{ marginTop: 24 }}>
            <div className="big">🎈</div>Здесь пока пусто
          </div>
        ) : (
          <section className="grid" style={{ marginTop: 24 }}>
            {guest.items.map((item) => (
              <Card
                key={item.id}
                item={item}
                cta={
                  item.reservedByMe ? (
                  <button className="pill mine" onClick={() => reserve(item)}>
                    Ты даришь ✓
                  </button>
                ) : item.reserved ? (
                  <span className="pill taken">Уже дарят</span>
                ) : (
                  <button className="pill" onClick={() => reserve(item)}>
                    Подарю
                  </button>
                )
                }
              />
            ))}
          </section>
        )}
        {toast && <div className="toast">{toast}</div>}
      </main>
    );
  }

  return (
    <main className="wrap">
      <header className="header">
        <div>
          <h1>
            wishlist<span>.</span>
          </h1>
          <p>Вставь ссылку на вещь — остальное подтянется само</p>
        </div>
        <div className="header-side">
          {total.count > 0 && (
            <div className="total">
              {total.count} {plural(total.count, ["желание", "желания", "желаний"])}
              {total.sum && <b>≈ {total.sum}</b>}
            </div>
          )}
          <button className="btn share" onClick={share}>
            Поделиться
          </button>
        </div>
      </header>

      <form className="add" onSubmit={fetchPreview}>
        <input
          type="text"
          inputMode="url"
          placeholder="Ссылка на вещь"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          onPaste={(e) => {
            const t = e.clipboardData.getData("text");
            if (/^https?:\/\//i.test(t.trim())) setTimeout(() => (e.target as HTMLInputElement).form?.requestSubmit(), 0);
          }}
        />
        <button className="btn" disabled={fetching || !link.trim()}>
          {fetching ? <span className="spinner" /> : "Добавить"}
        </button>
        <label className={`btn shot ${reading ? "busy" : ""}`} title="Добавить по скриншоту">
          {reading ? <span className="spinner" /> : "📸"}
          <input
            type="file"
            accept="image/*"
            hidden
            disabled={reading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) uploadScreenshot(f);
            }}
          />
        </label>
      </form>
      {reading && <p className="hint-line">Читаю скриншот — вырезаю фото, ищу цену и цвет…</p>}

      {error && <p className="error">{error}</p>}

      {draft && (
        <div className="draft">
          <div className="thumb" style={{ background: "var(--lavender)" }}>
            {draft.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={imgSrc(draft.image)!} alt="" />
            ) : (
              <span className="placeholder">🎁</span>
            )}
          </div>
          <div className="fields">
            {draft.warning && <p className="hint">{draft.warning}</p>}
            <label>
              Ссылка на товар
              <input
                inputMode="url"
                value={draft.url}
                placeholder="необязательно"
                onChange={(e) => setDraft({ ...draft, url: e.target.value })}
              />
            </label>
            <label>
              Название
              <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            </label>
            <div className="row">
              <label>
                Цена
                <input
                  inputMode="decimal"
                  value={draft.price ?? ""}
                  onChange={(e) => setDraft({ ...draft, price: e.target.value || null })}
                />
              </label>
              <label>
                Валюта
                <input
                  value={draft.currency ?? ""}
                  placeholder="RUB"
                  onChange={(e) => setDraft({ ...draft, currency: e.target.value || null })}
                />
              </label>
            </div>
            <label>
              Ссылка на фото
              <input
                value={
                  draft.image?.startsWith("tg:") || draft.image?.startsWith("img:")
                    ? "фото со скриншота ✓"
                    : draft.image ?? ""
                }
                readOnly={!!(draft.image?.startsWith("tg:") || draft.image?.startsWith("img:"))}
                placeholder="долгое нажатие на фото → копировать адрес"
                onChange={(e) => setDraft({ ...draft, image: e.target.value || null })}
              />
            </label>
            <label>
              Заметка
              <input
                value={draft.note}
                placeholder="размер, цвет…"
                onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              />
            </label>
            {!inTelegram && (
              <div className="actions">
                <button type="button" className="btn ghost" onClick={() => setDraft(null)}>
                  Отмена
                </button>
                <button type="button" className="btn" onClick={save}>
                  Сохранить
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <nav className="tabs">
        {(
          [
            ["wish", "Хочу"],
            ["done", "Получено"],
          ] as const
        ).map(([key, label]) => (
          <button key={key} className={`tab ${filter === key ? "active" : ""}`} onClick={() => setFilter(key)}>
            {label}
          </button>
        ))}
      </nav>

      {visible.length === 0 ? (
        <div className="empty-state">
          <div className="big">🌷</div>
          {filter === "done"
            ? "Здесь появятся исполненные желания"
            : "Пока пусто — вставь ссылку выше или просто пришли её боту в чат"}
        </div>
      ) : (
        <section className="grid">
          {visible.map((item) => (
            <Card
              key={item.id}
              item={item}
              actions={
                <>
                <button className="icon-btn" title="Изменить" onClick={() => setDraft({ ...item, editingId: item.id })}>
                  ✎
                </button>
                <button className="icon-btn" title={item.done ? "Вернуть" : "Получено"} onClick={() => toggleDone(item)}>
                  {item.done ? "↺" : "✓"}
                </button>
                <button className="icon-btn" title="Удалить" onClick={() => remove(item)}>
                  ✕
                </button>
                </>
              }
            />
          ))}
        </section>
      )}

      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}

function Card({ item, actions, cta }: { item: Item; actions?: React.ReactNode; cta?: React.ReactNode }) {
  const price = formatPrice(item.price, item.currency);
  const open = (e: React.MouseEvent) => {
    const tg = webApp();
    if (!item.url) e.preventDefault();
    else if (tg?.initData) {
      e.preventDefault();
      tg.openLink(item.url);
    }
  };
  return (
    <article className={`card ${item.done ? "done" : ""} ${item.reserved && !item.reservedByMe ? "taken-card" : ""}`}>
      <a href={item.url || undefined} target="_blank" rel="noreferrer" onClick={open}>
        <div className="thumb" style={{ background: colorFor(item.id) }}>
          {item.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={imgSrc(item.image)!} alt={item.title} loading="lazy" />
          ) : (
            <span className="placeholder">🎁</span>
          )}
        </div>
      </a>
      <div className="card-body">
        <div className="card-site">{item.site}</div>
        <a className="card-title" href={item.url || undefined} target="_blank" rel="noreferrer" onClick={open}>
          {item.title}
        </a>
        {item.note && <div className="card-note">{item.note}</div>}
        <div className="card-foot">
          {price ? <span className="price">{price}</span> : <span className="price empty">без цены</span>}
        </div>
        {cta && <div className="card-cta">{cta}</div>}
      </div>
      {actions && <div className="card-actions">{actions}</div>}
    </article>
  );
}

/** Downscale a phone screenshot before upload (keeps requests well under the 4.5 MB function limit). */
async function shrink(file: File): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return await new Promise((r) => canvas.toBlob((b) => r(b || file), "image/jpeg", 0.9));
  } catch {
    return file;
  }
}
