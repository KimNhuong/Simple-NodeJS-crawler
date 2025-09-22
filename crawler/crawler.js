import axios from "axios";
import { load } from "cheerio";
import Page from "../models/Page.js";
import CrawlQueue from "../models/CrawlQueue.js";

const visited = new Set();
let rootHostname = null;

const RATE_DELAY_MS = 800; // polite delay between requests
const MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 1000;
const CONCURRENCY = 5; // parallel workers for BFS
const MAX_DEPTH_DEFAULT = 6;

const axiosInstance = axios.create({
  headers: {
    "User-Agent":
      "Mozilla/5.0 (compatible; VnExpressCrawler/1.0; +https://example.com/bot)",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
  },
  timeout: 15000,
  validateStatus: (s) => s >= 200 && s < 400,
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(retryAfter) {
  if (!retryAfter) return null;
  const asInt = Number(retryAfter);
  if (!Number.isNaN(asInt)) return asInt * 1000;
  const dateTs = Date.parse(retryAfter);
  if (!Number.isNaN(dateTs)) return Math.max(0, dateTs - Date.now());
  return null;
}

async function fetchWithRetry(url) {
  let attempt = 0;
  while (true) {
    try {
      if (attempt === 0) {
        await sleep(RATE_DELAY_MS);
      }
      const resp = await axiosInstance.get(url);
      return resp.data;
    } catch (err) {
      const status = err.response?.status;
      const retryAfterHeader = err.response?.headers?.["retry-after"];
      attempt += 1;

      if (attempt > MAX_RETRIES) throw err;

      if (status === 429) {
        const retryMs = parseRetryAfter(retryAfterHeader) ?? BASE_BACKOFF_MS * 2 ** (attempt - 1);
        console.warn(`429 received. Waiting ${retryMs}ms before retry #${attempt} for`, url);
        await sleep(retryMs);
        continue;
      }

      if (status && status >= 500) {
        const waitMs = BASE_BACKOFF_MS * 2 ** (attempt - 1);
        console.warn(`Server ${status}. Backoff ${waitMs}ms before retry #${attempt} for`, url);
        await sleep(waitMs);
        continue;
      }

      if (!status) {
        const waitMs = BASE_BACKOFF_MS * 2 ** (attempt - 1);
        console.warn(`Network error. Backoff ${waitMs}ms before retry #${attempt} for`, url);
        await sleep(waitMs);
        continue;
      }

      throw err;
    }
  }
}

const TRACKING_PARAM_REGEX = /^(utm_|fbclid|gclid|yclid|mc_)/i;
const KEEP_QUERY_KEYS = new Set(["page", "p", "start", "offset", "cate", "category"]);

function normalizeUrl(rawUrl) {
  try {
    const urlObj = new URL(rawUrl);
    urlObj.protocol = "https:";
    urlObj.hash = "";
    if (urlObj.search) {
      const params = new URLSearchParams(urlObj.search);
      const next = new URLSearchParams();
      for (const [k, v] of params.entries()) {
        if (TRACKING_PARAM_REGEX.test(k)) continue;
        if (KEEP_QUERY_KEYS.has(k.toLowerCase())) next.set(k.toLowerCase(), v);
      }
      const query = next.toString();
      urlObj.search = query ? `?${query}` : "";
    }
    if (urlObj.pathname.endsWith("/") && urlObj.pathname !== "/") {
      urlObj.pathname = urlObj.pathname.slice(0, -1);
    }
    urlObj.hostname = urlObj.hostname.replace(/^www\./i, "");
    return urlObj.href;
  } catch {
    return null;
  }
}

function isSameSite(hostname) {
  if (!rootHostname) return false;
  const current = hostname.replace(/^www\./i, "");
  const root = rootHostname.replace(/^www\./i, "");
  return current === root || current.endsWith(`.${root}`);
}

function isLikelyArticle(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    return /\d{6,}/.test(path) || path.endsWith(".html") || /tin-/.test(path) || /bai-/.test(path);
  } catch {
    return false;
  }
}

async function pullNextBatch(limit) {
  // Atomically claim a batch: naive approach with transaction and status update
  const tx = await CrawlQueue.sequelize.transaction();
  try {
    const items = await CrawlQueue.findAll({
      where: { status: "queued" },
      order: [["priority", "DESC"], ["depth", "ASC"]],
      limit,
      lock: tx.LOCK.UPDATE,
      transaction: tx,
      skipLocked: true,
    });
    const ids = items.map((i) => i.id);
    if (ids.length > 0) {
      await CrawlQueue.update({ status: "processing" }, { where: { id: ids }, transaction: tx });
    }
    await tx.commit();
    return items;
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}

async function enqueueUrls(urls, parentDepth) {
  for (const url of urls) {
    try {
      await CrawlQueue.findOrCreate({
        where: { url },
        defaults: { depth: parentDepth + 1, status: "queued", priority: isLikelyArticle(url) ? 10 : 0 },
      });
    } catch {}
  }
}

export default async function crawl(seedUrlOrNull, maxDepth = MAX_DEPTH_DEFAULT) {
  if (seedUrlOrNull) {
    try {
      rootHostname = new URL(seedUrlOrNull).hostname.replace(/^www\./i, "");
    } catch {
      return;
    }
  } else {
    // infer root from any queued URL
    const any = await CrawlQueue.findOne({ where: { status: "queued" } });
    if (!any) return;
    try {
      rootHostname = new URL(any.url).hostname.replace(/^www\./i, "");
    } catch {
      return;
    }
  }

  // main loop: workers pull from DB queue
  async function worker() {
    while (true) {
      const batch = await pullNextBatch(1);
      if (!batch || batch.length === 0) break;
      const item = batch[0];
      const currentUrl = normalizeUrl(item.url);
      if (!currentUrl) {
        await item.update({ status: "failed", lastError: "normalize failed" });
        continue;
      }
      if (visited.has(currentUrl)) {
        await item.update({ status: "done" });
        continue;
      }
      visited.add(currentUrl);

      try {
        console.log("Crawling:", currentUrl, "depth:", item.depth);
        const html = await fetchWithRetry(currentUrl);
        const $ = load(html);

        const title = $("title").text() || null;
        const description = $('meta[name="description"]').attr("content") || null;

        let content = "";
        const candidates = [
          "article",
          ".fck_detail",
          ".article-detail",
          ".main_content",
          "#main_detail",
          "[itemprop='articleBody']",
        ];
        for (const sel of candidates) {
          const html = $(sel).first();
          if (html && html.text().trim().length > 100) {
            content = html
              .clone()
              .find("script, style, noscript, iframe, .copyright, .social, .related, .banner")
              .remove()
              .end()
              .text()
              .replace(/\s+/g, " ")
              .trim();
            break;
          }
        }

        await Page.upsert({ url: currentUrl, title, description, content: content || null });

        if (item.depth < maxDepth) {
          const links = $("a[href]")
            .map((i, el) => $(el).attr("href"))
            .get()
            .filter(Boolean);

          const nextLinks = [];
          for (const raw of links) {
            const absolute = raw.startsWith("http") ? raw : new URL(raw, currentUrl).href;
            const normalized = normalizeUrl(absolute);
            if (!normalized) continue;
            try {
              const { hostname } = new URL(normalized);
              if (!isSameSite(hostname)) continue;
            } catch {
              continue;
            }
            nextLinks.push(normalized);
          }

          await enqueueUrls(nextLinks, item.depth);
        }

        await item.update({ status: "done" });
      } catch (err) {
        const attempts = item.attempts + 1;
        const failed = attempts >= MAX_RETRIES;
        await item.update({ attempts, status: failed ? "failed" : "queued", lastError: err.message });
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);
}
