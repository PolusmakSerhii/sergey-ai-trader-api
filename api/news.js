const NEWS_CACHE_KEY = "crypto-ai:news-context:v3";
const NEWS_CACHE_TTL_SECONDS = 10 * 60;
const NEWS_LIMIT = 30;
const RSS_SOURCES = [
  {
    name: "ForkLog",
    url: "https://forklog.com/feed/"
  },
  {
    name: "Bits.media",
    url: "https://bits.media/rss2/"
  }
];

const BULLISH_TERMS = [
  "adoption", "approval", "approved", "breakout", "bullish",
  "growth", "launch", "partnership", "record high", "rally",
  "surge", "upgrade", "одобрение", "одобрил", "принятие",
  "рост", "запуск", "партнерство", "рекорд", "ралли",
  "прорыв", "обновление", "восстановление"
];

const BEARISH_TERMS = [
  "attack", "ban", "bearish", "breach", "crash", "decline",
  "exploit", "fraud", "hack", "lawsuit", "liquidation",
  "outflow", "sell-off", "атака", "запрет", "взлом",
  "мошенничество", "иск", "ликвидация", "отток", "падение",
  "обвал", "уязвимость", "эксплойт"
];

const HIGH_IMPACT_TERMS = [
  "bitcoin", "ethereum", "etf", "federal reserve", "fed",
  "inflation", "regulation", "sec", "stablecoin", "биткоин",
  "эфириум", "инфляция", "регулирование", "стейблкоин",
  "центробанк", "фрс"
];

function getRedisConfig() {
  const url = String(process.env.UPSTASH_REDIS_REST_URL || "")
    .replace(/\/$/, "");
  const token = String(process.env.UPSTASH_REDIS_REST_TOKEN || "");
  return url && token ? { url, token } : null;
}

async function runRedisCommand(command) {
  const config = getRedisConfig();
  if (!config) return null;

  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  if (!response.ok) {
    throw new Error(`Redis command failed: ${response.status}`);
  }

  const payload = await response.json();
  return payload?.result ?? null;
}

async function readNewsCache() {
  try {
    const cached = await runRedisCommand(["GET", NEWS_CACHE_KEY]);
    return typeof cached === "string" ? JSON.parse(cached) : null;
  } catch (error) {
    console.error("News cache read failed:", error);
    return null;
  }
}

async function writeNewsCache(context) {
  if (!getRedisConfig()) return false;

  try {
    await runRedisCommand([
      "SET",
      NEWS_CACHE_KEY,
      JSON.stringify(context),
      "EX",
      String(NEWS_CACHE_TTL_SECONDS)
    ]);
    return true;
  } catch (error) {
    console.error("News cache write failed:", error);
    return false;
  }
}

function countTerms(text, terms) {
  return terms.reduce(
    (count, term) => count + (text.includes(term) ? 1 : 0),
    0
  );
}

function decodeXml(value) {
  return String(value || "")
    .replace(/^<!\[CDATA\[|\]\]>$/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function readXmlTag(item, tag) {
  const match = item.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return decodeXml(match?.[1]);
}

function parseRss(xml, source) {
  return [...String(xml || "").matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)]
    .map((match, index) => {
      const item = match[1];
      const title = readXmlTag(item, "title");
      const url = readXmlTag(item, "link") || readXmlTag(item, "guid");
      const publishedAt = readXmlTag(item, "pubDate") || readXmlTag(item, "dc:date");

      return {
        id: `${source}:${url || title || index}`,
        title,
        body: readXmlTag(item, "description"),
        url,
        source,
        publishedAt
      };
    })
    .filter(article => article.title);
}

function sanitizeArticle(article) {
  const title = String(article?.title || "").trim();
  const body = String(article?.body || "").trim();
  const text = `${title} ${body}`.toLowerCase();
  const bullish = countTerms(text, BULLISH_TERMS);
  const bearish = countTerms(text, BEARISH_TERMS);
  const score = Math.max(-3, Math.min(3, bullish - bearish));

  return {
    id: String(article?.id || article?.guid || title),
    title,
    url: String(article?.url || ""),
    source: String(article?.source_info?.name || article?.source || "Unknown"),
    publishedAt: Number.isFinite(Number(article?.published_on))
      ? new Date(Number(article.published_on) * 1000).toISOString()
      : Number.isFinite(Date.parse(article?.publishedAt))
        ? new Date(article.publishedAt).toISOString()
        : null,
    score,
    sentiment: score > 0 ? "Bullish" : score < 0 ? "Bearish" : "Neutral",
    highImpact: HIGH_IMPACT_TERMS.some(term => text.includes(term))
  };
}

function createNewsContext(rawArticles) {
  const seen = new Set();
  const articles = rawArticles
    .map(sanitizeArticle)
    .filter(article => article.title)
    .filter(article => {
      const key = (article.url || article.title).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0))
    .slice(0, NEWS_LIMIT);
  const totalScore = articles.reduce((sum, article) => sum + article.score, 0);
  const normalizedScore = articles.length > 0
    ? Math.round((totalScore / (articles.length * 3)) * 100)
    : 0;
  const sentiment = normalizedScore >= 12
    ? "Bullish"
    : normalizedScore <= -12
      ? "Bearish"
      : "Neutral";

  return {
    ok: true,
    version: "1.0",
    source: [...new Set(articles.map(article => article.source))].join(" + ") || "Unavailable",
    generatedAt: new Date().toISOString(),
    sentiment,
    score: normalizedScore,
    articleCount: articles.length,
    highImpactCount: articles.filter(article => article.highImpact).length,
    informationalOnly: true,
    affectsTradingScore: false,
    articles: articles.slice(0, 8)
  };
}

async function fetchRssNews(source) {
  const response = await fetch(source.url, {
    headers: {
      Accept: "application/rss+xml, application/xml, text/xml",
      "User-Agent": "PhoenixAI-News/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`${source.name} RSS failed: ${response.status}`);
  }

  const articles = parseRss(await response.text(), source.name);
  if (articles.length === 0) {
    throw new Error(`${source.name} RSS returned no articles`);
  }
  return articles;
}

async function fetchNewsContext() {
  const sources = [
    ...RSS_SOURCES.map(fetchRssNews)
  ];
  const settled = await Promise.allSettled(sources);
  const articles = settled.flatMap(result =>
    result.status === "fulfilled" ? result.value : []
  );

  if (articles.length === 0) {
    throw new Error("All news sources failed");
  }

  return createNewsContext(articles);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const cached = await readNewsCache();
  if (cached) {
    return res.status(200).json({ ...cached, cache: { status: "hit" } });
  }

  try {
    const context = await fetchNewsContext();
    const cacheSaved = await writeNewsCache(context);
    return res.status(200).json({
      ...context,
      cache: { status: cacheSaved ? "stored" : "unavailable" }
    });
  } catch (error) {
    console.error("News context failed:", error);
    return res.status(200).json({
      ok: false,
      version: "1.0",
      source: "Unavailable",
      generatedAt: new Date().toISOString(),
      sentiment: "Neutral",
      score: 0,
      articleCount: 0,
      highImpactCount: 0,
      informationalOnly: true,
      affectsTradingScore: false,
      articles: [],
      error: "News context temporarily unavailable",
      cache: { status: "unavailable" }
    });
  }
}
