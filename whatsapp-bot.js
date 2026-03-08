require("dotenv").config();
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidBroadcast,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const axios = require("axios");
const pino = require("pino");
const path = require("path");
const fs = require("fs");

// ─── Config ─────────────────────────────────────────────────────────────────

const API_BASE = process.env.API_BASE || "http://localhost:3000";
const SESSION_DIR = process.env.WA_SESSION_DIR || "./wa-session";
const LOG_LEVEL = process.env.LOG_LEVEL || "silent";

const logger = pino({ level: LOG_LEVEL });
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

// ─── API helpers ─────────────────────────────────────────────────────────────

async function fetchBreaking() {
  const { data } = await axios.get(`${API_BASE}/api/breaking`, { timeout: 15000 });
  return data.data || [];
}

async function fetchPopular() {
  const { data } = await axios.get(`${API_BASE}/api/popular`, { timeout: 15000 });
  return data.data || [];
}

// ─── Formatters ──────────────────────────────────────────────────────────────

function formatBreaking(items) {
  if (!items.length) return "🔴 *Breaking News*\n\nNo breaking news at the moment.";

  // Filter to only show LIVE news, or fall back to the single top news item
  const liveItems = items.filter(b => b.isLive);
  const itemsToShow = liveItems.length > 0 ? liveItems : [items[0]];

  const lines = itemsToShow.map((item, i) => {
    const timePart = item.relativeTime ? ` _(${item.relativeTime})_` : "";
    const live = item.isLive ? "🔴 *LIVE* " : "";
    return `*${i + 1}.* ${live}${item.title}${timePart}\n🔗 ${item.url}`;
  }).join("\n\n");

  return `🔴 *Latest Breaking News*\n_Source: Khaleej Times_\n━━━━━━━━━━━━━━━━━━━━\n\n${lines}`;
}

function formatNews(items) {
  if (!items.length) return "📰 *Top News*\n\nNo articles found right now.";

  let output = "";

  // Rank 0 = top hero story, show it separately at the top
  const top = items.find((a) => a.isTop);
  const rest = items.filter((a) => !a.isTop).slice(0, 5);

  if (top) {
    const live = top.isLive ? "🔴 *LIVE* " : "⭐ ";
    const time = top.relativeTime || top.publishedAt || null;
    const timePart = time ? `\n🕐 _${time}_` : "";
    output += `🗞️ *LATEST STORY*\n━━━━━━━━━━━━━━━━━━━━\n${live}*${top.title}*${timePart}\n🔗 ${top.url}\n\n`;
  }

  const lines = rest.map((item) => {
    const live = item.isLive ? "🔴 *LIVE* " : "";
    const time = item.publishedAt || item.relativeTime || null;
    const timePart = time ? `\n🕐 _${time}_` : "";
    return `*${item.rank}.* ${live}${item.title}${timePart}\n🔗 ${item.url}`;
  }).join("\n\n");

  output += `📰 *Most Popular — Khaleej Times*\n━━━━━━━━━━━━━━━━━━━━\n\n${lines}`;
  return output;
}

function helpMessage() {
  return (
    `👋 *Khaleej Times News Bot*\n\n` +
    `🔴 */breaking* — Latest breaking news\n` +
    `📰 */news* — Top 5 most popular stories with timestamps\n\n` +
    `_Powered by khaleejtimes.com_`
  );
}

// ─── Command handler ─────────────────────────────────────────────────────────

async function handleCommand(sock, jid, text) {
  const cmd = text.trim().toLowerCase().split(/\s+/)[0];

  if (cmd === "/breaking") {
    await sock.sendMessage(jid, { text: "⏳ Fetching latest news..." });
    try {
      const items = await fetchBreaking();
      await sock.sendMessage(jid, { text: formatBreaking(items) });
    } catch (err) {
      console.error("[/breaking]", err.message);
      await sock.sendMessage(jid, { text: "❌ Failed to fetch news. Is the API server running?" });
    }

  } else if (cmd === "/news") {
    await sock.sendMessage(jid, { text: "⏳ Fetching top stories..." });
    try {
      const items = await fetchPopular();
      await sock.sendMessage(jid, { text: formatNews(items) });
    } catch (err) {
      console.error("[/news]", err.message);
      await sock.sendMessage(jid, { text: "❌ Failed to fetch news. Is the API server running?" });
    }

  } else if (["/help", "/start"].includes(cmd)) {
    await sock.sendMessage(jid, { text: helpMessage() });

  } else {
    await sock.sendMessage(jid, {
      text: `❓ Unknown command: *${cmd}*\n\nTry:\n• /breaking\n• /news`,
    });
  }
}

// ─── Bot core ─────────────────────────────────────────────────────────────────

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  console.log(`\n🤖 Khaleej Times WhatsApp Bot`);
  console.log(`   Baileys : v${version.join(".")}`);
  console.log(`   Session : ${path.resolve(SESSION_DIR)}`);
  console.log(`   API     : ${API_BASE}\n`);

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    shouldIgnoreJid: (jid) => isJidBroadcast(jid),
    generateHighQualityLinkPreview: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("\n📱 Scan this QR code in WhatsApp → Settings → Linked Devices:\n");
      try {
        require("qrcode-terminal").generate(qr, { small: true });
      } catch {
        console.log("QR (raw):", qr);
      }
    }
    if (connection === "open") {
      console.log("✅ WhatsApp connected! Send /breaking or /news to test.\n");
    }
    if (connection === "close") {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log("❌ Logged out. Delete ./wa-session and restart.");
        process.exit(1);
      } else {
        console.log(`⚠️  Disconnected (${code}), reconnecting in 5s...`);
        setTimeout(startBot, 5000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid === "status@broadcast") continue;

      const jid = msg.key.remoteJid;
      const text = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text || ""
      ).trim();

      if (!text.startsWith("/")) continue;

      console.log(`[msg] ${msg.pushName || jid}: ${text}`);
      await sock.readMessages([msg.key]);
      await handleCommand(sock, jid, text);
    }
  });
}

startBot().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});