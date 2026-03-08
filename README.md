# Khaleej Times News API

A lightweight Express API that scrapes breaking news and most popular articles from [khaleejtimes.com](https://www.khaleejtimes.com).

## Setup

```bash
npm install
npm start          # production
npm run dev        # development with hot-reload (nodemon)
```

Server starts on **http://localhost:3000** by default.  
Set `PORT=XXXX` env var to change it.

---

## Endpoints

### `GET /api/breaking`
Returns breaking news items from the ticker.

**Response:**
```json
{
  "success": true,
  "count": 2,
  "fetchedAt": "2025-03-07T10:00:00.000Z",
  "cached": false,
  "data": [
    {
      "title": "Emirates suspends flights to and from Dubai until further notice",
      "url": "https://www.khaleejtimes.com/business/aviation/emirates-suspends-flights..."
    }
  ]
}
```
Cache TTL: **2 minutes**

---

### `GET /api/popular`
Returns the most popular articles.

**Response:**
```json
{
  "success": true,
  "count": 5,
  "fetchedAt": "2025-03-07T10:00:00.000Z",
  "cached": false,
  "data": [
    {
      "rank": 1,
      "title": "Day 6 of US-Iran war: UAE intercepts more missiles...",
      "url": "https://www.khaleejtimes.com/world/mena/...",
      "isLive": false
    },
    {
      "rank": 3,
      "title": "DXB suspends operations; Emirates to resume flights...",
      "url": "https://www.khaleejtimes.com/world/mena/...",
      "isLive": true
    }
  ]
}
```
Cache TTL: **5 minutes**

---

### `GET /api/article?url=<article_url>`
Scrapes the full content of a specific article.

**Example:**
```
GET /api/article?url=https://www.khaleejtimes.com/business/aviation/emirates-suspends-flights
```

**Response:**
```json
{
  "success": true,
  "fetchedAt": "2025-03-07T10:00:00.000Z",
  "cached": false,
  "data": {
    "title": "Emirates suspends flights...",
    "description": "The airline said...",
    "author": "Staff Reporter",
    "publishedAt": "2025-03-07T08:30:00.000Z",
    "imageUrl": "https://...",
    "content": "Full article text...",
    "url": "https://www.khaleejtimes.com/..."
  }
}
```
Cache TTL: **10 minutes**

---

### `GET /api/all`
Returns both breaking news and most popular in one request — ideal for Telegram bot polling.

Cache TTL: **2 minutes**

---

### `DELETE /api/cache`
Flushes all cached data and forces fresh scrapes on next requests.

---

## Caching

| Endpoint    | TTL        |
|-------------|------------|
| `/breaking` | 2 minutes  |
| `/popular`  | 5 minutes  |
| `/all`      | 2 minutes  |
| `/article`  | 10 minutes |

Every response includes a `"cached": true/false` field.

---

## Telegram Bot Setup

### 1. Create your bot
- Open Telegram, message **@BotFather**
- Run `/newbot` → follow prompts → copy the **token**

### 2. Create a channel and add the bot
- Create a public or private Telegram channel
- Add your bot as an **Administrator** (with permission to post messages)
- Copy the channel username (e.g. `@mykhaleejnews`) or the numeric ID

### 3. Configure `.env`
```bash
cp .env.example .env
# Edit .env and fill in BOT_TOKEN and CHANNEL_ID
```

### 4. Run everything

**Terminal 1 — API server:**
```bash
npm run start:api
```

**Terminal 2 — Telegram bot:**
```bash
npm run start:bot
```

### Bot commands
| Command | Description |
|---|---|
| `/latest` | Top 5 most popular articles right now |
| `/breaking` | Current breaking news ticker |
| `/status` | Bot health, uptime, poll stats |

### How auto-broadcast works
- On first run the bot **seeds** its memory silently (no startup spam)
- Every 2 minutes it polls `/api/all`
- Any **new** breaking news → instant 🔴 alert to channel
- Any **new** trending story (top 5) → 📈 alert to channel
- Seen titles stored in memory — duplicates are never sent

---

## Legacy Telegram Bot snippet

Poll `/api/all` every 2 minutes to detect new breaking news.  
Compare titles against previously seen ones to fire alerts only for new items.

```js
// Minimal Telegram bot polling example
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const CHAT_ID = process.env.CHAT_ID;
const API = 'http://localhost:3000';

let seenBreaking = new Set();

async function poll() {
  const { data } = await axios.get(`${API}/api/all`);
  
  for (const item of data.breaking.data) {
    if (!seenBreaking.has(item.title)) {
      seenBreaking.add(item.title);
      bot.sendMessage(CHAT_ID, `🔴 *Breaking News*\n\n${item.title}\n${item.url}`, {
        parse_mode: 'Markdown'
      });
    }
  }
}

setInterval(poll, 2 * 60 * 1000); // every 2 min
poll(); // run immediately
```