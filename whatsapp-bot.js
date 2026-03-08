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
const axios   = require("axios");
const pino    = require("pino");
const path    = require("path");
const fs      = require("fs");

// ─── Config ────────────────────────────────────────────────────────────────

const API_BASE     = process.env.API_BASE || "http://localhost:3000";
const SESSION_DIR  = process.env.WA_SESSION_DIR || "./wa-session";
const LOG_LEVEL    = process.env.LOG_LEVEL || "silent"; // silent | info | debug

// ─── Logger (quiet by default — QR still prints to console) ────────────────

const logger = pino({ level: LOG_LEVEL });

// ─── Ensure session directory exists ───────────────────────────────────────

if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

// ─── API helpers ───────────────────────────────────────────────────────────

async function fetchBreaking() {
  const { data } = await axios.get(`${API_BASE}/api/breaking`, { timeout: 15000 });
  return data.data || [];
}

async function fetchPopular() {
  const { data } = await axios.get(`${API_BASE}/api/popular`, { timeout: 15000 });
  return data.data || [];
}

// ─── Message formatters ────────────────────────────────────────────────────

function formatBreaking(items) {
  if (!items.length) return "🔴 *Breaking News*\n\nNo breaking news at the moment.";

  const lines = items
    .map((item, i) => {
      const time = item.publishedAt
        ? `_(${new Date(item.publishedAt).toLocaleTimeString("en-AE", { timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit" })})_`
        : "";
      return `*${i + 1}.* ${item.title} ${time}\n🔗 ${item.url || ""}`;
    })
    .join("\n\n");

  return `🔴 *Breaking News*\n_Source: Khaleej Times_\n━━━━━━━━━━━━━━━━━━━━\n\n${lines}`;
}

function formatNews(items) {
  if (!items.length) return "📰 *Top News*\n\nNo articles found right now.";

  const lines = items
    .slice(0, 5)
    .map((item) => {
      const live = item.isLive ? "🔴 *LIVE* " : "";
      return `*${item.rank}.* ${live}${item.title}\n🔗 ${item.url || ""}`;
    })
    .join("\n\n");

  return `📰 *Top News — Most Popular*\n_Source: Khaleej Times_\n━━━━━━━━━━━━━━━━━━━━\n\n${lines}`;
}

function helpMessage() {
  return (
    `👋 *Khaleej Times News Bot*\n\n` +
    `Send a command to get the latest news:\n\n` +
    `🔴 */breaking* — Current breaking news\n` +
    `📰 */news* — Top 5 most popular stories\n\n` +
    `_Powered by khaleejtimes.com_`
  );
}

// ─── Command handler ────────────────────────────────────────────────────────

async function handleCommand(sock, jid, text) {
  const cmd = text.trim().toLowerCase().split(/\s+/)[0];

  if (cmd === "/breaking") {
    await sock.sendMessage(jid, { text: "⏳ Fetching breaking news..." });
    try {
      const items = await fetchBreaking();
      await sock.sendMessage(jid, { text: formatBreaking(items) });
    } catch (err) {
      console.error("[/breaking error]", err.message);
      await sock.sendMessage(jid, { text: "❌ Failed to fetch breaking news. Make sure the API server is running." });
    }

  } else if (cmd === "/news") {
    await sock.sendMessage(jid, { text: "⏳ Fetching top news..." });
    try {
      const items = await fetchPopular();
      await sock.sendMessage(jid, { text: formatNews(items) });
    } catch (err) {
      console.error("[/news error]", err.message);
      await sock.sendMessage(jid, { text: "❌ Failed to fetch news. Make sure the API server is running." });
    }

  } else if (cmd === "/help" || cmd === "/start") {
    await sock.sendMessage(jid, { text: helpMessage() });

  } else {
    // Unknown command — show help
    await sock.sendMessage(jid, {
      text: `❓ Unknown command: *${cmd}*\n\nAvailable:\n• /breaking\n• /news`,
    });
  }
}

// ─── Bot core ───────────────────────────────────────────────────────────────

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  console.log(`\n🤖 Khaleej Times WhatsApp Bot`);
  console.log(`   Baileys version : ${version.join(".")}`);
  console.log(`   Session dir     : ${path.resolve(SESSION_DIR)}`);
  console.log(`   API base        : ${API_BASE}\n`);

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    // Don't receive broadcast/status messages
    shouldIgnoreJid: (jid) => isJidBroadcast(jid),
    generateHighQualityLinkPreview: false,
    markOnlineOnConnect: false,
  });

  // ── Save credentials whenever they update ──
  sock.ev.on("creds.update", saveCreds);

  // ── Connection handling ──
  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      // Print QR to terminal — user scans with WhatsApp
      console.log("\n📱 Scan this QR code with WhatsApp (Linked Devices):\n");
      // Baileys prints the QR automatically when using console; we also import qrcode-terminal for a bigger render
      try {
        const qrcode = require("qrcode-terminal");
        qrcode.generate(qr, { small: true });
      } catch {
        console.log("QR:", qr); // fallback if qrcode-terminal not installed
      }
    }

    if (connection === "open") {
      console.log("✅ WhatsApp connected! Bot is ready.\n");
      console.log("   Send /breaking or /news to your WhatsApp number to test.\n");
    }

    if (connection === "close") {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log(`⚠️  Connection closed — reason: ${reason}`);

      if (reason === DisconnectReason.loggedOut) {
        console.log("❌ Logged out. Delete the session folder and restart to re-link.");
        process.exit(1);
      } else {
        console.log("🔄 Reconnecting in 5s...");
        setTimeout(startBot, 5000);
      }
    }
  });

  // ── Incoming message handler ──
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      // Skip: own messages, status updates, no content
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid === "status@broadcast") continue;

      const jid  = msg.key.remoteJid;
      const text = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        ""
      ).trim();

      if (!text.startsWith("/")) continue; // only handle commands

      const sender = msg.pushName || jid;
      console.log(`[msg] ${sender} (${jid}): ${text}`);

      // Mark as read
      await sock.readMessages([msg.key]);

      await handleCommand(sock, jid, text);
    }
  });
}

startBot().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
