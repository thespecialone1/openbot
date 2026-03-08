/**
 * summary.js
 * Builds a spoken news summary from live + popular articles,
 * converts it to audio via ElevenLabs TTS, and caches the result
 * for 6 hours so we don't burn free-tier credits.
 */

const axios = require("axios");
const cheerio = require("cheerio");

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // Rachel

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

// ─── In-process 6-hour cache ─────────────────────────────────────────────────

let _cachedAudio = null;        // Buffer
let _cachedText = null;         // Plain text of the last summary
let _cacheTimestamp = 0;        // Date.now() when it was created

function isCacheStale() {
    return Date.now() - _cacheTimestamp > SIX_HOURS_MS;
}

function getCachedSummary() {
    if (_cachedAudio && !isCacheStale()) {
        return { audio: _cachedAudio, text: _cachedText, cached: true };
    }
    return null;
}

function setCachedSummary(audio, text) {
    _cachedAudio = audio;
    _cachedText = text;
    _cacheTimestamp = Date.now();
}

// ─── Article description scraper ─────────────────────────────────────────────

/**
 * Scrape the lead paragraph or OG description from a KT article URL.
 * Returns a 1-2 sentence plain-text extract for TTS.
 */
async function scrapeArticleDescription(url) {
    try {
        const res = await axios.get(url, {
            timeout: 10000,
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
            },
        });
        const $ = cheerio.load(res.data);

        // Try OG description (usually the editor-written summary)
        const ogDesc = $('meta[property="og:description"]').attr("content") ||
            $('meta[name="description"]').attr("content") || "";
        if (ogDesc && ogDesc.length > 40) return ogDesc.trim();

        // Fall back to first meaty paragraph in the article body
        let fallback = "";
        $("article p, .story-body p, .article-body p").each((_, el) => {
            const text = $(el).text().trim();
            if (!fallback && text.length > 60) fallback = text;
        });
        return fallback || null;
    } catch {
        return null;
    }
}

// ─── Summary text builder ─────────────────────────────────────────────────────

/**
 * Builds the spoken summary script from:
 *  - liveItems: result of /api/breaking (filtered to live or top 1)
 *  - popularItems: result of /api/popular (top 3 by recency)
 *
 * Returns a plain text string suitable for TTS.
 */
async function buildSummaryText(liveItems, popularItems) {
    const parts = [];

    // Intro
    const now = new Date().toLocaleString("en-AE", {
        timeZone: "Asia/Dubai",
        weekday: "long",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
    });
    parts.push(`Khaleej Times News Summary. ${now}.`);

    // ── Live / Breaking section ──────────────────────────────────────────────
    const liveOrTop = liveItems.filter(b => b.isLive);
    const source = liveOrTop.length > 0 ? liveOrTop : liveItems.slice(0, 1);

    if (source.length > 0) {
        parts.push("Breaking News.");
        for (const item of source) {
            const desc = item.url ? await scrapeArticleDescription(item.url) : null;
            if (desc) {
                parts.push(`${item.title}. ${desc}`);
            } else {
                parts.push(item.title);
            }
        }
    }

    // ── Top 3 popular by recency ─────────────────────────────────────────────
    // Popular list is already sorted newest-first by scraper.js
    const topThree = popularItems.filter(a => !a.isTop).slice(0, 3);

    if (topThree.length > 0) {
        parts.push("Top Stories.");
        for (const item of topThree) {
            const desc = item.url ? await scrapeArticleDescription(item.url) : null;
            const when = item.publishedAt ? `, published ${item.publishedAt}` : "";
            if (desc) {
                parts.push(`${item.title}${when}. ${desc}`);
            } else {
                parts.push(`${item.title}${when}.`);
            }
        }
    }

    parts.push("That is all for this summary. Stay tuned to Khaleej Times for the latest updates.");
    return parts.join(" ");
}

// ─── ElevenLabs TTS ──────────────────────────────────────────────────────────

/**
 * Convert text to speech using ElevenLabs API.
 * Returns a Buffer containing the MP3 audio.
 */
async function synthesizeAudio(text) {
    if (!ELEVENLABS_API_KEY) {
        throw new Error("ELEVENLABS_API_KEY is not set in .env");
    }

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`;
    const response = await axios.post(
        url,
        {
            text,
            model_id: "eleven_monolingual_v1",
            voice_settings: {
                stability: 0.5,
                similarity_boost: 0.5,
            },
        },
        {
            headers: {
                "xi-api-key": ELEVENLABS_API_KEY,
                "Content-Type": "application/json",
                Accept: "audio/mpeg",
            },
            responseType: "arraybuffer",
            timeout: 60000,
        }
    );

    return Buffer.from(response.data);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Main entry point — called by the WhatsApp bot's /summary handler.
 * Returns { audio: Buffer, text: string, cached: boolean }
 *
 * @param {Array} liveItems  — from /api/breaking
 * @param {Array} popularItems — from /api/popular
 */
async function generateSummary(liveItems, popularItems) {
    // Serve cached copy if still fresh
    const cached = getCachedSummary();
    if (cached) return cached;

    const text = await buildSummaryText(liveItems, popularItems);
    const audio = await synthesizeAudio(text);
    setCachedSummary(audio, text);
    return { audio, text, cached: false };
}

module.exports = { generateSummary, getCachedSummary };
