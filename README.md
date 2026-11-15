# Wishlist — Telegram Mini App

Telegram-бот + Mini App для вишлиста. Присылаешь ссылку на вещь или скриншот товара — фото, название, цена и цвет подтягиваются сами.
Вишлистом можно поделиться: друзья открывают его в Telegram и тайно бронируют подарки (владелец не видит, кто что дарит).

## Возможности
- **Ссылка** → разбор страницы (JSON-LD, OpenGraph, запасные селекторы). Если магазин блокирует ботов — вторая попытка через ScrapingBee (если задан ключ), иначе название берётся из URL.
- **Скриншот** → модель с компьютерным зрением (GLM через Z.ai, запасной — Claude через Vercel AI Gateway) находит название, цену, цвет, размер и вырезает только фото товара.
- **Бот**: `/start`, кнопка меню «Вишлист», добавление по ссылке/скриншоту прямо из чата.
- **Mini App**: родные кнопки Telegram, редактирование, «Получено», «Поделиться», бронирование подарков друзьями.
- Каждый запрос проверяется по подписи Telegram `initData`.

## Стек
Next.js (App Router) на Vercel · Upstash Redis (Vercel Marketplace) · Telegram Bot API.

## Локально
    npm install
    npm run dev        # вне Telegram используется тестовый пользователь
Данные локально лежат в `.data/db.json`.

## Переменные окружения
См. `.env.example`.

| Переменная | Зачем |
|---|---|
| `BOT_TOKEN` | токен бота из @BotFather |
| `WEBHOOK_SECRET` | случайная строка, защищает `/api/bot` |
| `NEXT_PUBLIC_BOT_USERNAME` | username бота для ссылок «Поделиться» |
| `APP_URL` | публичный https-адрес приложения |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Upstash Redis (добавляются интеграцией) |
| `SCRAPINGBEE_API_KEY` | необязательно: обход защиты от ботов |
| `ZAI_API_KEY`, `GLM_MODEL` | распознавание скриншотов через GLM |
| `ANTHROPIC_API_KEY` | необязательно: Claude напрямую вместо AI Gateway |

## Запуск в Telegram
1. Деплой на Vercel, подключить Upstash Redis, задать переменные выше.
2. `curl -X POST https://<app>/api/setup` — вебхук, кнопка меню, команды, описание бота.
3. @BotFather → Bot Settings → Configure Mini App → Enable → тот же URL (нужно для ссылок `t.me/<bot>?startapp=<id>`).
