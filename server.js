const express = require("express");
const NodeCache = require("node-cache");
const { scrapeBreakingNews, scrapeMostPopular, scrapeArticle } = require("./scraper");

const app = express();
const PORT = process.env.PORT || 3000;

// Cache: breaking news = 2 min, popular = 5 min, articles = 10 min
const cache = new NodeCache({ stdTTL: 120, checkperiod: 60 });

app.use(express.json());

// ─── Helpers ───────────────────────────────────────────────────────────────

function cacheMiddleware(key, ttlSeconds) {
  return async (req, res, next) => {
    const cacheKey = key || req.originalUrl;
    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json({ ...cached, cached: true });
    }
    res.locals.cacheKey = cacheKey;
    res.locals.cacheTTL = ttlSeconds;
    next();
  };
}

function sendAndCache(res, data) {
  const key = res.locals.cacheKey;
  const ttl = res.locals.cacheTTL;
  if (key) cache.set(key, data, ttl);
  return res.json({ ...data, cached: false });
}

// ─── Routes ────────────────────────────────────────────────────────────────

/**
 * GET /
 * Health check
 */
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    name: "Khaleej Times News API",
    endpoints: {
      breaking: "GET /api/breaking",
      popular: "GET /api/popular",
      article: "GET /api/article?url=<article_url>",
      all: "GET /api/all",
    },
  });
});

/**
 * GET /api/breaking
 * Returns the current breaking news ticker items
 */
app.get("/api/breaking", cacheMiddleware("breaking", 120), async (req, res) => {
  try {
    const news = await scrapeBreakingNews();
    sendAndCache(res, {
      success: true,
      count: news.length,
      fetchedAt: new Date().toISOString(),
      data: news,
    });
  } catch (err) {
    console.error("[breaking]", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/popular
 * Returns the most popular articles list
 */
app.get("/api/popular", cacheMiddleware("popular", 300), async (req, res) => {
  try {
    const articles = await scrapeMostPopular();
    sendAndCache(res, {
      success: true,
      count: articles.length,
      fetchedAt: new Date().toISOString(),
      data: articles,
    });
  } catch (err) {
    console.error("[popular]", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/article?url=<article_url>
 * Scrapes and returns full content for a specific article
 * Example: /api/article?url=https://www.khaleejtimes.com/some/article-slug
 */
app.get("/api/article", async (req, res) => {
  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ success: false, error: "Missing ?url= parameter" });
  }

  // Validate it's a Khaleej Times URL
  if (!url.includes("khaleejtimes.com")) {
    return res
      .status(400)
      .json({ success: false, error: "URL must be from khaleejtimes.com" });
  }

  const cacheKey = `article:${url}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const article = await scrapeArticle(url);
    const payload = {
      success: true,
      fetchedAt: new Date().toISOString(),
      data: article,
    };
    cache.set(cacheKey, payload, 600); // 10 min cache for article content
    res.json({ ...payload, cached: false });
  } catch (err) {
    console.error("[article]", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/all
 * Returns breaking news + most popular in one shot (useful for Telegram bot polling)
 */
app.get("/api/all", cacheMiddleware("all", 120), async (req, res) => {
  try {
    const [breaking, popular] = await Promise.all([
      scrapeBreakingNews(),
      scrapeMostPopular(),
    ]);

    sendAndCache(res, {
      success: true,
      fetchedAt: new Date().toISOString(),
      breaking: { count: breaking.length, data: breaking },
      popular: { count: popular.length, data: popular },
    });
  } catch (err) {
    console.error("[all]", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/cache
 * Clear all cached data (useful for forcing a fresh scrape)
 */
app.delete("/api/cache", (req, res) => {
  cache.flushAll();
  res.json({ success: true, message: "Cache cleared" });
});

// ─── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🗞  Khaleej Times News API running on http://localhost:${PORT}`);
  console.log(`   Endpoints:`);
  console.log(`     GET  /api/breaking     → Breaking news ticker`);
  console.log(`     GET  /api/popular      → Most popular articles`);
  console.log(`     GET  /api/article?url= → Full article content`);
  console.log(`     GET  /api/all          → Breaking + popular combined`);
  console.log(`     DELETE /api/cache      → Clear cache\n`);
});
