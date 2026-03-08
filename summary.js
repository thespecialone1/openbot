/**
 * summary.js
 * Generates a concise spoken news summary using the official ElevenLabs SDK.
 * Results are cached for 6 hours to protect free-tier token budget.
 */

const { ElevenLabsClient } = require("@elevenlabs/elevenlabs-js");
const axios = require("axios");
const cheerio = require("cheerio");

const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb"; // Rachel default
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

// ─── 6-hour cache ────────────────────────────────────────────────────────────

let _cachedAudio = null;   // Buffer
let _cachedText = null;    // plain text script
let _cacheTimestamp = 0;

function isFresh() {
    return _cachedAudio && (Date.now() - _cacheTimestamp < SIX_HOURS_MS);
}

function getCachedSummary() {
    if (isFresh()) return { audio: _cachedAudio, text: _cachedText, cached: true };
    return null;
}

function setCached(audio, text) {
    _cachedAudio = audio;
    _cachedText = text;
    _cacheTimestamp = Date.now();
}

// ─── Article lead-sentence extractor ─────────────────────────────────────────

async function getLeadLine(url) {
    try {
        const res = await axios.get(url, {
            timeout: 8000,
            headers: { "User-Agent": "Mozilla/5.0 Chrome/124.0" },
        });
        const $ = cheerio.load(res.data);

        // OG description is usually the editor-written intro — best token value
        const og = $('meta[property="og:description"]').attr("content") ||
            $('meta[name="description"]').attr("content") || "";
        if (og.length > 30) {
            // Keep it to the first sentence to save characters
            return og.split(/[.\n]/)[0].trim().slice(0, 160);
        }

        // Fallback: first meaty paragraph
        let found = "";
        $("article p, .story-body p, .article-body p").each((_, el) => {
            const t = $(el).text().trim();
            if (!found && t.length > 50) found = t.slice(0, 160);
        });
        return found || null;
    } catch {
        return null;
    }
}

// ─── Script builder ───────────────────────────────────────────────────────────

/**
 * Builds a short TTS script (keeps it under ~800 chars to save tokens).
 * - 1 live/breaking story
 * - Top 3 popular by recency
 */
async function buildScript(liveItems, popularItems) {
    const lines = [];

    const now = new Date().toLocaleString("en-AE", {
        timeZone: "Asia/Dubai",
        weekday: "long",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
    });
    lines.push(`Khaleej Times. ${now}.`);

    // Breaking / Live
    const live = liveItems.filter(b => b.isLive);
    const topBreaking = live.length > 0 ? live[0] : liveItems[0];
    if (topBreaking) {
        const lead = topBreaking.url ? await getLeadLine(topBreaking.url) : null;
        lines.push(`Breaking. ${topBreaking.title}. ${lead || ""}`);
    }

    // Top 3 popular (already sorted newest-first by scraper)
    const top3 = popularItems.filter(a => !a.isTop).slice(0, 3);
    if (top3.length) lines.push("Top stories.");
    for (const item of top3) {
        const lead = item.url ? await getLeadLine(item.url) : null;
        lines.push(`${item.title}. ${lead || ""}`);
    }

    lines.push("This has been a news report from Khaleej Times. Stay tuned to OpenBot.");
    return lines.join(" ").replace(/\s+/g, " ").trim();
}

// ─── ElevenLabs TTS via official SDK ─────────────────────────────────────────

async function synthesize(text) {
    if (!process.env.ELEVENLABS_API_KEY) {
        throw new Error("ELEVENLABS_API_KEY is not set in .env");
    }

    const client = new ElevenLabsClient({
        apiKey: process.env.ELEVENLABS_API_KEY,
    });

    const audioStream = await client.textToSpeech.convert(VOICE_ID, {
        text,
        modelId: "eleven_multilingual_v2",
        outputFormat: "mp3_44100_128",
    });

    // Collect stream into Buffer
    const chunks = [];
    for await (const chunk of audioStream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function generateSummary(liveItems, popularItems) {
    const cached = getCachedSummary();
    if (cached) return cached;

    const text = await buildScript(liveItems, popularItems);
    const audio = await synthesize(text);
    setCached(audio, text);
    return { audio, text, cached: false };
}

module.exports = { generateSummary, getCachedSummary };
