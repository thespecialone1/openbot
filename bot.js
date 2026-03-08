require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

// ─── Config ────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;   // e.g. "@mychannel" or "-100xxxxxxxx"
const API_BASE = process.env.API_BASE || "http://localhost:3000";
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "120000"); // 2 min default

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is missing in .env");
if (!CHANNEL_ID) throw new Error("CHANNEL_ID is missing in .env");

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ─── State ─────────────────────────────────────────────────────────────────

const seenBreaking = new Set();
const seenPopular = new Set();
let isFirstRun = true;
let pollCount = 0;
let lastPollTime = null;
let pollErrors = 0;

// ─── Formatters ────────────────────────────────────────────────────────────

function formatBreakingAlert(item) {
  const timePart = item.relativeTime ? `\n🕐 _${escMd(item.relativeTime)}_` : "";
  const live = item.isLive ? "🔴 *LIVE* " : "";
  return (
    `🔴 *BREAKING NEWS*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${live}${escMd(item.title)}${timePart}\n\n` +
    `🔗 ${mdLink("Read full story", item.url)}\n` +
    `_Source: Khaleej Times_`
  );
}

function formatPopularAlert(item) {
  const liveTag = item.isLive ? "🔴 *LIVE* " : "";
  const timePart = item.publishedAt ? `\n🕐 _${escMd(item.publishedAt)}_` : "";
  return (
    `📈 *TRENDING \\#${item.rank}*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${liveTag}${escMd(item.title)}${timePart}\n\n` +
    `🔗 ${mdLink("Read full story", item.url)}\n` +
    `_Source: Khaleej Times_`
  );
}

function formatLatestList(popular) {
  let output = "";

  // Rank 0 = hero top story — show first with special label
  const top = popular.find((a) => a.isTop);
  const rest = popular.filter((a) => !a.isTop).slice(0, 5);

  if (top) {
    const live = top.isLive ? "🔴 *LIVE* " : "⭐ ";
    const time = top.relativeTime || top.publishedAt || null;
    const timePart = time ? `\n🕐 _${escMd(time)}_` : "";
    output +=
      `🗞️ *LATEST STORY*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `${live}[${escMd(top.title)}](${top.url})${timePart}\n\n`;
  }

  const lines = rest.map((a) => {
    const live = a.isLive ? "🔴 " : "";
    const time = a.publishedAt || a.relativeTime || null;
    const timePart = time ? `\n    🕐 _${escMd(time)}_` : "";
    return `*${a.rank}\\.* ${live}[${escMd(a.title)}](${a.url})${timePart}`;
  });

  output +=
    `📰 *Most Popular Right Now*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    lines.join("\n\n") +
    `\n\n_Source: Khaleej Times_`;

  return output;
}

function formatBreakingList(breaking) {
  if (!breaking.length) return "No breaking news right now\\.";

  // Filter to only show LIVE news, or fall back to the single top news item
  const liveItems = breaking.filter(b => b.isLive);
  const itemsToShow = liveItems.length > 0 ? liveItems : [breaking[0]];

  const lines = itemsToShow.map((b, i) => {
    const live = b.isLive ? "🔴 " : "";
    const time = b.relativeTime ? `\n    🕐 _${escMd(b.relativeTime)}_` : "";
    return `*${i + 1}\\.* ${live}${mdLink(b.title, b.url)}${time}`;
  });
  return (
    `🔴 *Latest Breaking News*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    lines.join("\n\n") +
    `\n\n_Source: Khaleej Times_`
  );
}

// Escape special MarkdownV2 chars
function escMd(text) {
  return (text || "").replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

// Safe link: falls back to plain URL if title has unescapable content
function mdLink(title, url) {
  if (!url) return escMd(title);
  // URLs inside () must have ) escaped
  const safeUrl = (url || "").replace(/\)/g, "\)");
  return `[${escMd(title)}](${safeUrl})`;
}

// ─── API helpers ───────────────────────────────────────────────────────────

async function fetchAll() {
  const { data } = await axios.get(`${API_BASE}/api/all`, { timeout: 15000 });
  return data;
}

async function fetchBreaking() {
  const { data } = await axios.get(`${API_BASE}/api/breaking`, { timeout: 15000 });
  return data.data || [];
}

async function fetchPopular() {
  const { data } = await axios.get(`${API_BASE}/api/popular`, { timeout: 15000 });
  return data.data || [];
}

// ─── Broadcast ─────────────────────────────────────────────────────────────

async function broadcast(text) {
  try {
    await bot.sendMessage(CHANNEL_ID, text, {
      parse_mode: "MarkdownV2",
      disable_web_page_preview: false,
    });
  } catch (err) {
    console.error("[broadcast error]", err.message);
  }
}

// ─── Poller ────────────────────────────────────────────────────────────────

async function poll() {
  try {
    const result = await fetchAll();
    const { breaking, popular } = result;

    pollCount++;
    lastPollTime = new Date();
    pollErrors = 0;

    if (isFirstRun) {
      // Seed seen sets without broadcasting on startup
      (breaking.data || []).forEach((b) => seenBreaking.add(b.title));
      (popular.data || []).forEach((p) => seenPopular.add(p.title));
      isFirstRun = false;
      console.log(
        `[poll #${pollCount}] Seeded ${seenBreaking.size} breaking, ` +
        `${seenPopular.size} popular — now watching for changes.`
      );
      return;
    }

    // Check for new breaking news
    for (const item of (breaking.data || [])) {
      if (!seenBreaking.has(item.title)) {
        seenBreaking.add(item.title);
        console.log(`[NEW BREAKING] ${item.title}`);
        await broadcast(formatBreakingAlert(item));
      }
    }

    // Check for new most-popular entries (rank 1–5 only)
    for (const item of (popular.data || []).slice(0, 5)) {
      if (!seenPopular.has(item.title)) {
        seenPopular.add(item.title);
        console.log(`[NEW POPULAR #${item.rank}] ${item.title}`);
        await broadcast(formatPopularAlert(item));
      }
    }

    console.log(
      `[poll #${pollCount}] OK — ` +
      `${breaking.data?.length || 0} breaking, ${popular.data?.length || 0} popular`
    );
  } catch (err) {
    pollErrors++;
    console.error(`[poll error #${pollErrors}]`, err.message);
  }
}

// ─── Commands ──────────────────────────────────────────────────────────────

// /start — welcome message
bot.onText(/\/start/, async (msg) => {
  const name = msg.from?.first_name || "there";
  await bot.sendMessage(
    msg.chat.id,
    `👋 Hey ${name}\\! I'm the *Khaleej Times News Bot*\\.\n\n` +
    `I auto\\-broadcast breaking news and trending stories to this channel\\.\n\n` +
    `*Commands:*\n` +
    `/latest \\— Top 5 most popular right now\n` +
    `/breaking \\— Current breaking news\n` +
    `/status \\— Bot health & stats`,
    { parse_mode: "MarkdownV2" }
  );
});

// /latest — show top 5 popular with inline Read More buttons
bot.onText(/\/latest/, async (msg) => {
  try {
    const popular = await fetchPopular();
    if (!popular.length) {
      return bot.sendMessage(msg.chat.id, "No popular articles found right now\\.", { parse_mode: "MarkdownV2" });
    }

    const top = popular.find(a => a.isTop);
    const rest = popular.filter(a => !a.isTop).slice(0, 5);
    const all = top ? [top, ...rest] : rest;

    for (const item of all) {
      const live = item.isLive ? "🔴 *LIVE* " : (item.isTop ? "⭐ " : "");
      const time = item.publishedAt || item.relativeTime || null;
      const timePart = time ? `\n🕐 _${escMd(time)}_` : "";
      const rank = item.isTop ? "*TOP STORY*" : `*#${item.rank}*`;
      const text =
        `${rank}\n` +
        `${live}${escMd(item.title)}${timePart}`;

      await bot.sendMessage(msg.chat.id, text, {
        parse_mode: "MarkdownV2",
        reply_markup: item.url ? {
          inline_keyboard: [[
            { text: "Read Full Story", url: item.url },
          ]]
        } : undefined,
      });
    }
  } catch (err) {
    await bot.sendMessage(msg.chat.id, `❌ Failed to fetch latest news\\. Try again shortly\\.`, {
      parse_mode: "MarkdownV2",
    });
  }
});

// /breaking — current breaking news with inline Read More button
bot.onText(/\/breaking/, async (msg) => {
  try {
    const breaking = await fetchBreaking();
    if (!breaking.length) {
      return bot.sendMessage(msg.chat.id, "No breaking news right now\\.", { parse_mode: "MarkdownV2" });
    }

    const liveItems = breaking.filter(b => b.isLive);
    const itemsToShow = liveItems.length > 0 ? liveItems : [breaking[0]];

    for (const item of itemsToShow) {
      const live = item.isLive ? "🔴 *LIVE* " : "";
      const time = item.relativeTime ? `\n🕐 _${escMd(item.relativeTime)}_` : "";
      const text =
        `🔴 *BREAKING*\n` +
        `${live}${escMd(item.title)}${time}`;

      await bot.sendMessage(msg.chat.id, text, {
        parse_mode: "MarkdownV2",
        reply_markup: item.url ? {
          inline_keyboard: [[
            { text: "Read Full Story", url: item.url },
          ]]
        } : undefined,
      });
    }
  } catch (err) {
    await bot.sendMessage(msg.chat.id, `❌ Failed to fetch breaking news\\. Try again shortly\\.`, {
      parse_mode: "MarkdownV2",
    });
  }
});

// /status — bot health
bot.onText(/\/status/, async (msg) => {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);

  const lastPoll = lastPollTime
    ? escMd(lastPollTime.toUTCString())
    : "Not yet polled";

  const text =
    `✅ *Khaleej Times Bot Status*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⏱ Uptime: \`${hours}h ${minutes}m ${seconds}s\`\n` +
    `🔄 Poll count: \`${pollCount}\`\n` +
    `🕐 Last poll: \`${lastPoll}\`\n` +
    `⚠️ Poll errors: \`${pollErrors}\`\n` +
    `📡 Poll interval: \`${POLL_INTERVAL_MS / 1000}s\`\n` +
    `📰 Seen breaking: \`${seenBreaking.size}\`\n` +
    `📈 Seen popular: \`${seenPopular.size}\`\n` +
    `🌐 API: \`${escMd(API_BASE)}\``;

  await bot.sendMessage(msg.chat.id, text, { parse_mode: "MarkdownV2" });
});

// ─── Start ─────────────────────────────────────────────────────────────────

console.log("🤖 Khaleej Times Telegram Bot starting...");
console.log(`   Channel : ${CHANNEL_ID}`);
console.log(`   API     : ${API_BASE}`);
console.log(`   Interval: ${POLL_INTERVAL_MS / 1000}s`);

// Delay first poll by 5s to let Telegram drop any previous connection
setTimeout(() => {
  poll();
  setInterval(poll, POLL_INTERVAL_MS);
}, 5000);

// Handle polling errors — auto-recover from 409 Conflict
let _conflictRecovery = false;
bot.on("polling_error", (err) => {
  const msg = err.message || "";
  if ((msg.includes("409") || msg.includes("Conflict")) && !_conflictRecovery) {
    _conflictRecovery = true;
    console.warn("[polling] 409 Conflict — stopping, waiting 15s then resuming...");
    bot.stopPolling().then(() => {
      setTimeout(() => {
        bot.startPolling();
        _conflictRecovery = false;
        console.log("[polling] Resumed after conflict recovery.");
      }, 15000);
    }).catch(() => { });
  } else if (!msg.includes("409") && !msg.includes("Conflict")) {
    console.error("[polling error]", msg);
  }
});

console.log("Bot is running!\n");