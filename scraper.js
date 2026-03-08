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

/**
 * Fetch and parse the Khaleej Times homepage (used by most-popular + article)
 */
async function fetchHomepage() {
  const response = await axiosInstance.get("/");
  return cheerio.load(response.data);
}

// ─── Breaking News ──────────────────────────────────────────────────────────

/**
 * Fetch breaking news via Quintype's internal REST API.
 *
 * Why not HTML scraping?
 * The breaking news ticker is rendered by JavaScript at runtime —
 * cheerio only parses the static HTML, so it always returns nothing.
 * Quintype CMS (which KT runs on) exposes /api/v1/breaking-news directly.
 */
async function scrapeBreakingNews() {
  const response = await axiosInstance.get("/api/v1/breaking-news", {
    headers: {
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
      Referer: BASE_URL,
    },
  });

  // Response shape: { "breaking-news": [ { headline, slug, published-at, ... } ] }
  const items = response.data?.["breaking-news"] || [];

  const seen = new Set();
  const results = [];

  for (const item of items) {
    const title = item.headline || item.title || "";
    if (!title || seen.has(title)) continue;
    seen.add(title);

    const slug = item.slug || item.url || "";
    let url = null;
    if (slug) {
      url = slug.startsWith("http") ? slug : `${BASE_URL}/${slug.replace(/^\//, "")}`;
    }

    results.push({
      title,
      url,
      publishedAt: item["published-at"]
        ? new Date(item["published-at"]).toISOString()
        : null,
    });
  }

  return results;
}

// ─── Most Popular ───────────────────────────────────────────────────────────

/**
 * Scrape most popular articles from the homepage.
 * This section IS server-side rendered, so cheerio works fine.
 */
async function scrapeMostPopular() {
  const $ = await fetchHomepage();
  const articles = [];

  const container = $(".most-popular-right-nf");

  container.find("a").each((i, el) => {
    const rawTitle = $(el).text().trim().replace(/\s+/g, " ");
    if (!rawTitle) return;

    const isLive =
      $(el).find(".live-tag, [class*='live']").length > 0 ||
      rawTitle.toLowerCase().startsWith("live");

    const title = rawTitle.replace(/^Live\s*/i, "").trim();
    const href = $(el).attr("href");
    const url = href
      ? href.startsWith("http")
        ? href.split("?")[0]
        : `${BASE_URL}${href.split("?")[0]}`
      : null;

    articles.push({ rank: i + 1, title, url, isLive });
  });

  return articles;
}

// ─── Article Content ────────────────────────────────────────────────────────

/**
 * Scrape full content of a specific article.
 */
async function scrapeArticle(articleUrl) {
  const url = articleUrl.startsWith("http")
    ? articleUrl
    : `${BASE_URL}${articleUrl}`;

  const response = await axiosInstance.get(url);
  const $ = cheerio.load(response.data);

  const title = $("h1.headline, h1.story-title, h1[class*='title'], h1")
    .first()
    .text()
    .trim();

  const description = $('meta[name="description"], meta[property="og:description"]')
    .first()
    .attr("content");

  const publishedAt =
    $('meta[property="article:published_time"], time[datetime]').first().attr("content") ||
    $("time").first().attr("datetime");

  const author = $(".author-name, .byline, [class*='author']").first().text().trim();

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
    author: author || null,
    publishedAt: publishedAt || null,
    imageUrl: imageUrl || null,
    content: paragraphs.join("\n\n") || null,
    url,
  };
}

module.exports = {
  scrapeBreakingNews,
  scrapeMostPopular,
  scrapeArticle,
};