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
const { generateSummary } = require("./summary");

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
  if (!items.length) return "BREAKING NEWS\n\nNo breaking news at the moment.";

  const liveItems = items.filter(b => b.isLive);
  const itemsToShow = liveItems.length > 0 ? liveItems : [items[0]];

  const lines = itemsToShow.map((item, i) => {
    const timePart = item.relativeTime ? ` (${item.relativeTime})` : "";
    const live = item.isLive ? "[LIVE] " : "";
    return `${i + 1}. ${live}${item.title}${timePart}\n${item.url}`;
  }).join("\n\n");

  return `BREAKING NEWS\nSource: Khaleej Times\n${"─".repeat(20)}\n\n${lines}`;
}

function formatNews(items) {
  if (!items.length) return "TOP NEWS\n\nNo articles found right now.";

  let output = "";

  const top = items.find((a) => a.isTop);
  const rest = items.filter((a) => !a.isTop).slice(0, 5);

  if (top) {
    const live = top.isLive ? "[LIVE] " : "[TOP STORY] ";
    const time = top.publishedAt || top.relativeTime || null;
    const timePart = time ? `\n${time}` : "";
    output += `LATEST STORY\n${"─".repeat(20)}\n${live}*${top.title}*${timePart}\n${top.url}\n\n`;
  }

  const lines = rest.map((item) => {
    const live = item.isLive ? "[LIVE] " : "";
    const time = item.publishedAt || item.relativeTime || null;
    const timePart = time ? `\n  ${time}` : "";
    return `${item.rank}. ${live}${item.title}${timePart}\n   ${item.url}`;
  }).join("\n\n");

  output += `MOST POPULAR - Khaleej Times\n${"─".repeat(20)}\n\n${lines}`;
  return output;
}

function menuMessage() {
  return (
    `Khaleej Times News Bot\n${"─".repeat(20)}\n\n` +
    `Commands:\n\n` +
    `1. /news       - Top 5 popular stories\n` +
    `2. /breaking   - Latest breaking / live news\n` +
    `3. /summary    - Audio news summary (every 6 hours)\n` +
    `4. /bot        - Show this menu\n\n` +
    `Powered by khaleejtimes.com`
  );
}

// ─── Command handler ─────────────────────────────────────────────────────────

async function handleCommand(sock, jid, text) {
  const cmd = text.trim().toLowerCase().split(/\s+/)[0];

  // ── /breaking ──────────────────────────────────────────────────────────────
  if (cmd === "/breaking") {
    try {
      const items = await fetchBreaking();
      const liveOrTop = items.filter(b => b.isLive).length > 0
        ? items.filter(b => b.isLive)
        : [items[0]];

      // Send text first
      await sock.sendMessage(jid, { text: formatBreaking(items) });

      // Try sending the image for the top item
      const topItem = liveOrTop[0];
      if (topItem?.url) {
        try {
          const res = await axios.get(topItem.url, { timeout: 8000, headers: { "User-Agent": "Mozilla/5.0" } });
          const cheerio = require("cheerio");
          const $ = cheerio.load(res.data);
          const img = $('meta[property="og:image"]').attr("content");
          if (img) {
            await sock.sendMessage(jid, {
              image: { url: img },
              caption: topItem.title,
            });
          }
        } catch { /* image is optional, ignore errors */ }
      }
    } catch (err) {
      console.error("[/breaking]", err.message);
      await sock.sendMessage(jid, { text: "Failed to fetch news. Is the API server running?" });
    }

    // ── /news ──────────────────────────────────────────────────────────────────
  } else if (cmd === "/news") {
    try {
      const items = await fetchPopular();
      await sock.sendMessage(jid, { text: formatNews(items) });

      // Send thumbnail for the top/hero story
      const topItem = items.find(a => a.isTop) || items[0];
      if (topItem?.url) {
        try {
          const res = await axios.get(topItem.url, { timeout: 8000, headers: { "User-Agent": "Mozilla/5.0" } });
          const cheerio = require("cheerio");
          const $ = cheerio.load(res.data);
          const img = $('meta[property="og:image"]').attr("content");
          if (img) {
            await sock.sendMessage(jid, {
              image: { url: img },
              caption: topItem.title,
            });
          }
        } catch { /* image is optional, ignore errors */ }
      }
    } catch (err) {
      console.error("[/news]", err.message);
      await sock.sendMessage(jid, { text: "Failed to fetch news. Is the API server running?" });
    }

    // ── /summary ───────────────────────────────────────────────────────────────
  } else if (cmd === "/summary") {
    try {
      const [breaking, popular] = await Promise.all([fetchBreaking(), fetchPopular()]);
      const result = await generateSummary(breaking, popular);

      const cachedNote = result.cached
        ? "\n\n[Cached summary - refreshes every 6 hours]"
        : "\n\n[Fresh summary generated]";

      // Send audio as voice note (ptt = push-to-talk / voice note format)
      await sock.sendMessage(jid, {
        audio: result.audio,
        mimetype: "audio/mpeg",
        ptt: true, // sends as voice note
      });

      await sock.sendMessage(jid, {
        text: `Audio summary sent.${cachedNote}`,
      });
    } catch (err) {
      console.error("[/summary]", err.message);
      let errMsg = "Failed to generate audio summary.";
      if (err.message.includes("ELEVENLABS_API_KEY")) {
        errMsg = "ElevenLabs API key is not configured. Please add ELEVENLABS_API_KEY to the .env file.";
      } else if (err.response?.status === 401) {
        errMsg = "ElevenLabs API key is invalid or expired.";
      } else if (err.response?.status === 429) {
        errMsg = "ElevenLabs rate limit reached. Please wait before trying again.";
      }
      await sock.sendMessage(jid, { text: errMsg });
    }

    // ── /bot (interactive menu) ─────────────────────────────────────────────────
  } else if (["/bot", "/help", "/start"].includes(cmd)) {
    // Try to send interactive list message (supported on WhatsApp mobile)
    try {
      await sock.sendMessage(jid, {
        listMessage: {
          title: "Khaleej Times News Bot",
          description: "Select an option to get started",
          buttonText: "Open Menu",
          listType: 1,
          sections: [
            {
              title: "News",
              rows: [
                { title: "1. Latest News", rowId: "/news", description: "Top 5 popular stories" },
                { title: "2. Breaking News", rowId: "/breaking", description: "Live and breaking headlines" },
                { title: "3. Audio Summary", rowId: "/summary", description: "AI news summary every 6 hours" },
              ],
            },
            {
              title: "Info",
              rows: [
                { title: "4. Help", rowId: "/bot", description: "Show this menu again" },
              ],
            },
          ],
        },
      });
    } catch {
      // Fallback for clients that don't support list messages
      await sock.sendMessage(jid, { text: menuMessage() });
    }

  } else {
    await sock.sendMessage(jid, {
      text: `Unknown command: ${cmd}\n\nSend /bot to see the menu.`,
    });
  }
}

// ─── Bot core ─────────────────────────────────────────────────────────────────

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  console.log(`\n--- Khaleej Times WhatsApp Bot ---`);
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
      console.log("\nScan this QR code in WhatsApp > Settings > Linked Devices:\n");
      try {
        require("qrcode-terminal").generate(qr, { small: true });
      } catch {
        console.log("QR (raw):", qr);
      }
    }
    if (connection === "open") {
      console.log("WhatsApp connected! Send /bot to see the menu.\n");
    }
    if (connection === "close") {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log("Logged out. Delete ./wa-session and restart.");
        process.exit(1);
      } else {
        console.log(`Disconnected (${code}), reconnecting in 5s...`);
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
        msg.message?.extendedTextMessage?.text ||
        // Handle list reply selections (user tapping a menu option)
        msg.message?.listResponseMessage?.selectedRowId || ""
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