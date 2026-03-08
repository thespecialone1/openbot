const axios = require("axios");
const cheerio = require("cheerio");

const BASE_URL = "https://www.khaleejtimes.com";

const axiosInstance = axios.create({
  baseURL: BASE_URL,
  timeout: 15000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    "Accept-Encoding": "gzip, deflate, br",
    Connection: "keep-alive",
  },
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Convert Khaleej Times relative timestamps ("35m ago", "2h ago", "Just now")
 * into a human-friendly Dubai-time string for display.
 */
function parseRelativeTime(relText) {
  if (!relText) return null;
  const t = relText.trim().toLowerCase();
  if (t.includes("just now") || t.includes("now")) return "Just now";
  // Return the string as-is — it's already human readable ("35m ago", "2h ago", "21h ago")
  return relText.trim().replace(/\s+/g, " ");
}

/**
 * Extract slug from a KT URL path for use with Quintype story API.
 * e.g. "/world/mena/some-article?utm=..." → "world/mena/some-article"
 */
function slugFromUrl(href) {
  try {
    const clean = href.split("?")[0].replace(/^\//, "");
    return clean;
  } catch {
    return null;
  }
}

/**
 * Fetch story metadata (published-at, author) from Quintype story-by-slug API.
 * Returns null on failure — caller should handle gracefully.
 */
async function fetchStoryMeta(slug) {
  try {
    const res = await axiosInstance.get(`/api/v1/stories-by-slug?slug=${slug}`, {
      headers: { Accept: "application/json" },
      timeout: 8000,
    });
    const story = res.data?.story;
    if (!story) return null;

    const publishedAt = story["published-at"]
      ? new Date(story["published-at"]).toLocaleString("en-AE", {
        timeZone: "Asia/Dubai",
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      })
      : null;

    return {
      publishedAt,
      author: story["author-name"] || story.authors?.[0]?.name || null,
    };
  } catch {
    return null;
  }
}

// ─── Fetch & cache homepage ──────────────────────────────────────────────────

let _homepageCache = null;
let _homepageCacheTime = 0;

async function fetchHomepage() {
  const now = Date.now();
  if (_homepageCache && now - _homepageCacheTime < 60_000) {
    return _homepageCache; // reuse within 60s to avoid double-fetching
  }
  const response = await axiosInstance.get("/");
  _homepageCache = cheerio.load(response.data);
  _homepageCacheTime = now;
  return _homepageCache;
}

// ─── Breaking / Latest News ─────────────────────────────────────────────────

/**
 * Scrape the latest news from the homepage main story cards.
 *
 * Why not /api/v1/breaking-news?
 *   That Quintype endpoint is currently empty on khaleejtimes.com.
 *   The main story grid IS server-side rendered and always has the freshest
 *   headlines with relative timestamps ("Just now", "35m ago", etc.)
 */
async function scrapeBreakingNews() {
  const $ = await fetchHomepage();
  const results = [];
  const seen = new Set();

  // Each story card on the homepage: contains an <a> with the headline and
  // a sibling/child element with the relative time string.
  // Covers both big hero card and smaller story list items.
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";

    // Only pick article links (have at least 2 path segments, no anchors/external)
    if (!href.startsWith("/") || href.split("/").length < 3) return;
    if (href.includes("#") || href.includes("utm")) return;

    // Get headline text — prefer <h1>/<h2>/<h3> inside the link, else link text
    const headingEl = $(el).find("h1, h2, h3").first();
    const title = (headingEl.length ? headingEl.text() : $(el).text())
      .trim()
      .replace(/\s+/g, " ")
      .replace(/^Live\s*/i, "")
      .trim();

    if (!title || title.length < 15) return;
    if (seen.has(title)) return;
    seen.add(title);

    // Look for relative time near this element
    const parent = $(el).closest("div, li, article");
    const rawTime =
      parent.find("time, [class*='time'], [class*='ago'], span").filter((_, t) => {
        const txt = $(t).text().trim();
        return /ago|now|just|min|hour|hr|day/i.test(txt);
      }).first().text().trim() || null;

    const isLive = $(el).text().toLowerCase().includes("live") ||
      $(el).find("[class*='live']").length > 0;

    const url = `${BASE_URL}${href.split("?")[0]}`;

    results.push({
      title,
      url,
      relativeTime: parseRelativeTime(rawTime),
      isLive,
    });

    if (results.length >= 10) return false; // stop after 10
  });

  return results;
}

// ─── Top Story (Hero) ────────────────────────────────────────────────────────

/**
 * Scrape the hero/featured story at the very top of the homepage (.top-nf).
 * This is always the most recent/live article KT is highlighting.
 */
async function scrapeTopStory() {
  const $ = await fetchHomepage();
  const el = $(".top-nf a").first();
  if (!el.length) return null;

  const href = el.attr("href") || "";
  const url = href.startsWith("http") ? href.split("?")[0] : `${BASE_URL}${href.split("?")[0]}`;
  const slug = slugFromUrl(href);

  const title = el.find("h1").text()
    .replace(/Live/gi, "").replace(/\s+/g, " ").trim();

  const isLive = el.find(".pulsB, [class*='live'], .pulse1").length > 0 ||
    el.text().toLowerCase().includes("live");

  const rawTime = el.find(".st-h-m-nf").text().trim() || null;

  const meta = slug ? await fetchStoryMeta(slug) : null;

  return {
    title,
    url,
    isLive,
    relativeTime: parseRelativeTime(rawTime),
    publishedAt: meta?.publishedAt || null,
    author: meta?.author || null,
  };
}

// ─── Most Popular ────────────────────────────────────────────────────────────

/**
 * Scrape most popular articles and enrich each with a publish timestamp
 * by calling the Quintype stories-by-slug API.
 */
async function scrapeMostPopular() {
  const $ = await fetchHomepage();
  const articles = [];

  $(".most-popular-right-nf a").each((i, el) => {
    const rawTitle = $(el).text().trim().replace(/\s+/g, " ");
    if (!rawTitle) return;

    const isLive =
      $(el).find("[class*='live']").length > 0 ||
      rawTitle.toLowerCase().startsWith("live");

    const title = rawTitle.replace(/^Live\s*/i, "").trim();
    const href = $(el).attr("href") || "";
    const slug = slugFromUrl(href);
    const url = href
      ? href.startsWith("http")
        ? href.split("?")[0]
        : `${BASE_URL}${href.split("?")[0]}`
      : null;

    articles.push({ rank: i + 1, title, url, slug, isLive });
  });

  // Enrich with publish timestamps from Quintype story API (parallel)
  const enriched = await Promise.all(
    articles.map(async (article) => {
      const meta = article.slug ? await fetchStoryMeta(article.slug) : null;
      const { slug, ...rest } = article; // drop internal slug field
      return {
        ...rest,
        publishedAt: meta?.publishedAt || null,
        author: meta?.author || null,
      };
    })
  );

  // Prepend the top hero story if it's not already in the list
  const top = await scrapeTopStory();
  if (top && !enriched.some((a) => a.title === top.title)) {
    return [{ rank: 0, isTop: true, ...top }, ...enriched.map((a) => ({ ...a, rank: a.rank + 1 }))];
  }
  return enriched;
}

// ─── Article Content ─────────────────────────────────────────────────────────

async function scrapeArticle(articleUrl) {
  const url = articleUrl.startsWith("http")
    ? articleUrl
    : `${BASE_URL}${articleUrl}`;

  const slug = slugFromUrl(url.replace(BASE_URL, ""));
  const [pageRes, meta] = await Promise.all([
    axiosInstance.get(url),
    fetchStoryMeta(slug),
  ]);

  const $ = cheerio.load(pageRes.data);

  const title = $("h1.headline, h1.story-title, h1[class*='title'], h1")
    .first().text().trim();

  const description = $('meta[name="description"], meta[property="og:description"]')
    .first().attr("content");

  const imageUrl =
    $('meta[property="og:image"]').first().attr("content") ||
    $("article img, .story-img img").first().attr("src");

  const paragraphs = [];
  $("article p, .story-body p, .article-body p, [class*='story'] p").each((_, el) => {
    const text = $(el).text().trim();
    if (text.length > 40) paragraphs.push(text);
  });

  return {
    title,
    description: description || null,
    author: meta?.author || null,
    publishedAt: meta?.publishedAt || null,
    imageUrl: imageUrl || null,
    content: paragraphs.join("\n\n") || null,
    url,
  };
}

module.exports = {
  scrapeBreakingNews,
  scrapeMostPopular,
  scrapeTopStory,
  scrapeArticle,
};