const fs = require("fs/promises");
const path = require("path");

const ROOT_DIR = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const GENERATED_DIR = path.join(PUBLIC_DIR, "data");
const SNAPSHOTS_FILE = path.join(DATA_DIR, "snapshots.json");
const DETAILS_FILE = path.join(DATA_DIR, "details-cache.json");
const SITE_DATA_FILE = path.join(GENERATED_DIR, "site-data.json");
const LIST_PAGES = [1, 2, 3, 4, 5];
const EXPECTED_MODELS_PER_PAGE = 60;
const UNKNOWN_VALUE = "\u041d\u0435 \u0443\u043a\u0430\u0437\u0430\u043d\u0430";
const UNTITLED_VALUE = "\u0411\u0435\u0437 \u043d\u0430\u0437\u0432\u0430\u043d\u0438\u044f";
const REQUEST_TIMEOUT_MS = 30000;
const MAX_FETCH_RETRIES = 3;
const DETAIL_DELAY_MS = Number(process.env.DETAIL_DELAY_MS || 1500);
const MAX_DETAILS_PER_RUN = Number(process.env.MAX_DETAILS_PER_RUN || 25);
const SITE_TIMEZONE = process.env.SITE_TIMEZONE || "Europe/Minsk";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error(`Failed to read ${filePath}:`, error);
    }
    return fallback;
  }
}

async function writeJson(filePath, payload) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function decodeMojibake(value) {
  if (typeof value !== "string") {
    return value;
  }

  if (!/[\u00d0\u00d1]/.test(value)) {
    return value;
  }

  try {
    return Buffer.from(value, "latin1").toString("utf8");
  } catch {
    return value;
  }
}

function normalizeWhitespace(value) {
  return decodeMojibake(String(value || "")).replace(/\s+/g, " ").trim();
}

function normalizeCategoryValue(value) {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return "";
  }

  return normalized.replace(/^\d+\s*\/\s*/, "").trim();
}

function normalizeModel(model) {
  return {
    title: normalizeWhitespace(model.title) || UNTITLED_VALUE,
    url: model.url,
    imageUrl: model.imageUrl,
    page: Number(model.page || 0),
    points: Number(model.points || 0),
    category: normalizeCategoryValue(model.category) || UNKNOWN_VALUE,
    publishedAt: normalizeWhitespace(model.publishedAt) || UNKNOWN_VALUE,
  };
}

function sortSnapshots(list) {
  return [...list].sort((a, b) => a.date.localeCompare(b.date));
}

async function loadSnapshots() {
  const snapshots = await readJson(SNAPSHOTS_FILE, []);
  return sortSnapshots(
    snapshots.map((snapshot) => ({
      date: snapshot.date,
      collectedAt: snapshot.collectedAt,
      models: Array.isArray(snapshot.models) ? snapshot.models.map(normalizeModel) : [],
    })),
  );
}

async function saveSnapshots(snapshots) {
  await writeJson(SNAPSHOTS_FILE, sortSnapshots(snapshots));
}

async function loadDetailsCache() {
  const details = await readJson(DETAILS_FILE, {});
  return Object.fromEntries(
    Object.entries(details).map(([url, entry]) => [
      url,
      {
        title: normalizeWhitespace(entry.title),
        imageUrl: entry.imageUrl,
        url,
        category: normalizeCategoryValue(entry.category) || UNKNOWN_VALUE,
        publishedAt: normalizeWhitespace(entry.publishedAt) || UNKNOWN_VALUE,
        checkedAt: entry.checkedAt || null,
      },
    ]),
  );
}

async function saveDetailsCache(details) {
  await writeJson(DETAILS_FILE, details);
}

function getTodayKey() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: SITE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  return formatter.format(new Date());
}

function toProxyUrl(targetUrl) {
  return `https://r.jina.ai/http://${targetUrl.replace(/^https?:\/\//, "")}`;
}

async function fetchText(targetUrl, attempt = 1) {
  try {
    const response = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 SiteStat/1.0",
        Accept: "text/plain, text/markdown;q=0.9, */*;q=0.8",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      if ((response.status === 429 || response.status >= 500) && attempt < MAX_FETCH_RETRIES) {
        await sleep(1500 * attempt);
        return fetchText(targetUrl, attempt + 1);
      }
      throw new Error(`HTTP ${response.status} for ${targetUrl}`);
    }

    return response.text();
  } catch (error) {
    if (attempt < MAX_FETCH_RETRIES) {
      await sleep(1500 * attempt);
      return fetchText(targetUrl, attempt + 1);
    }
    throw error;
  }
}

function extractCatalogSection(markdown) {
  const startIndex = markdown.indexOf("\u041d\u0430\u0439\u0434\u0435\u043d\u043e");
  const endCandidates = [
    markdown.indexOf("[\u0421\u043b\u0435\u0434\u0443\u044e\u0449\u0430\u044f \u0441\u0442\u0440\u0430\u043d\u0438\u0446\u0430]"),
    markdown.indexOf("\u0412\u0441\u0435\u0433\u043e "),
  ].filter((value) => value > startIndex);

  if (startIndex === -1) {
    return markdown;
  }

  if (!endCandidates.length) {
    return markdown.slice(startIndex);
  }

  return markdown.slice(startIndex, Math.min(...endCandidates));
}

function isValidCatalogModel(model) {
  return (
    model.title &&
    model.title.toLowerCase() !== "null" &&
    model.url &&
    !model.url.endsWith("/show/null") &&
    model.imageUrl &&
    !model.imageUrl.endsWith("/no-image.svg")
  );
}

function parseListPage(markdown, pageNumber) {
  const section = extractCatalogSection(markdown);
  const itemRegex =
    /\[!\[Image\s+\d+(?::\s*([^\]]*))?\]\((https?:\/\/[^\s)]+)\)\]\((https:\/\/3ddd\.ru\/3dmodels\/show\/[^)]+)\)/g;

  const models = [];
  let match;

  while ((match = itemRegex.exec(section)) !== null) {
    models.push({
      title: normalizeWhitespace(match[1] || "") || UNTITLED_VALUE,
      url: match[3],
      imageUrl: match[2],
      page: pageNumber,
      points: Math.max(1, 6 - pageNumber),
      category: UNKNOWN_VALUE,
      publishedAt: UNKNOWN_VALUE,
    });
  }

  return Array.from(new Map(models.filter(isValidCatalogModel).map((model) => [model.url, model])).values());
}

function parseCategory(markdown) {
  const categoryRegex =
    /\[([^\]]+)\]\(https:\/\/3ddd\.ru\/3dmodels\?(?:subcat=[^)\s]+&)?cat=[^)\s]+\)/g;
  const categories = [];
  let match;

  while ((match = categoryRegex.exec(markdown)) !== null) {
    const category = normalizeWhitespace(match[1]);
    if (category && !categories.includes(category)) {
      categories.push(category);
    }
  }

  if (!categories.length) {
    const titleMatch = markdown.match(/^Title:\s+(.+?)\s+-\s+3D \u043c\u043e\u0434\u0435\u043b\u044c/m);
    if (titleMatch) {
      const parts = normalizeWhitespace(titleMatch[1])
        .split(" - ")
        .map((part) => part.trim())
        .filter(Boolean);
      if (parts.length >= 2) {
        return normalizeCategoryValue(parts.at(-1)) || UNKNOWN_VALUE;
      }
    }
    return UNKNOWN_VALUE;
  }

  return normalizeCategoryValue(categories.slice(0, 2).join(" / ")) || UNKNOWN_VALUE;
}

function parsePublishedAt(markdown) {
  const marker = "\u041e\u043f\u0443\u0431\u043b\u0438\u043a\u043e\u0432\u0430\u043d\u0430";
  const index = markdown.indexOf(marker);
  if (index === -1) {
    return UNKNOWN_VALUE;
  }

  const snippet = markdown.slice(index, index + 80);
  const match = snippet.match(/([0-9]{1,2}\s+[\p{L}]+\s+\d{4})/u);
  return match ? normalizeWhitespace(match[1]) : UNKNOWN_VALUE;
}

function mergeDetails(model, detailsCache) {
  const cached = detailsCache[model.url];
  if (!cached) {
    return model;
  }

  return {
    ...model,
    category: cached.category || model.category,
    publishedAt: cached.publishedAt || model.publishedAt,
  };
}

async function fetchCatalogModels(detailsCache) {
  async function fetchPageModels(pageNumber, attempt = 1) {
    const markdown = await fetchText(toProxyUrl(`https://3ddd.ru/3dmodels?order=sell_rating&page=${pageNumber}`));
    const models = parseListPage(markdown, pageNumber);

    if (models.length !== EXPECTED_MODELS_PER_PAGE) {
      if (attempt < MAX_FETCH_RETRIES) {
        await sleep(1500 * attempt);
        return fetchPageModels(pageNumber, attempt + 1);
      }

      throw new Error(
        `Parsed ${models.length} valid models from page ${pageNumber}, expected ${EXPECTED_MODELS_PER_PAGE}`,
      );
    }

    return models.map((model) => mergeDetails(model, detailsCache));
  }

  const pageModels = await Promise.all(
    LIST_PAGES.map((pageNumber) => fetchPageModels(pageNumber)),
  );

  return pageModels.flat();
}

async function fetchModelDetails(model) {
  const markdown = await fetchText(toProxyUrl(model.url));
  return {
    title: model.title,
    imageUrl: model.imageUrl,
    url: model.url,
    category: parseCategory(markdown),
    publishedAt: parsePublishedAt(markdown),
    checkedAt: new Date().toISOString(),
  };
}

function aggregateSnapshots(snapshots, fromDate, toDate) {
  const filtered = snapshots.filter((snapshot) => {
    if (fromDate && snapshot.date < fromDate) {
      return false;
    }
    if (toDate && snapshot.date > toDate) {
      return false;
    }
    return true;
  });

  const byUrl = new Map();

  for (const snapshot of filtered) {
    snapshot.models.forEach((model, index) => {
      const rank = index + 1;
      const existing = byUrl.get(model.url);

      if (!existing) {
        byUrl.set(model.url, {
          url: model.url,
          title: model.title,
          imageUrl: model.imageUrl,
          category: model.category,
          publishedAt: model.publishedAt,
          totalPoints: model.points,
          appearances: 1,
          bestRank: rank,
          latestPage: model.page,
          lastSeenAt: snapshot.date,
        });
        return;
      }

      existing.totalPoints += model.points;
      existing.appearances += 1;
      existing.bestRank = Math.min(existing.bestRank, rank);

      if (snapshot.date >= existing.lastSeenAt) {
        existing.title = model.title;
        existing.imageUrl = model.imageUrl;
        existing.category = model.category;
        existing.publishedAt = model.publishedAt;
        existing.latestPage = model.page;
        existing.lastSeenAt = snapshot.date;
      }
    });
  }

  const models = Array.from(byUrl.values())
    .sort((a, b) => {
      if (b.totalPoints !== a.totalPoints) {
        return b.totalPoints - a.totalPoints;
      }
      if (b.appearances !== a.appearances) {
        return b.appearances - a.appearances;
      }
      return a.bestRank - b.bestRank;
    })
    .map((model, index) => ({ ...model, rank: index + 1 }));

  return {
    fromDate,
    toDate,
    snapshotCount: filtered.length,
    count: models.length,
    missingDetailsCount: models.filter(
      (model) => model.category === UNKNOWN_VALUE || model.publishedAt === UNKNOWN_VALUE,
    ).length,
    models,
  };
}

function buildSiteData(snapshots) {
  const availableDates = snapshots.map((snapshot) => snapshot.date);
  const latestCollectedAt = snapshots[snapshots.length - 1]?.collectedAt || null;
  const range = {
    min: availableDates[0] || null,
    max: availableDates[availableDates.length - 1] || null,
  };

  const periods = {
    latest: aggregateSnapshots(snapshots, range.max, range.max),
  };

  if (range.min && range.max) {
    periods.all = aggregateSnapshots(snapshots, range.min, range.max);
  }

  return {
    generatedAt: new Date().toISOString(),
    latestCollectedAt,
    availableDates,
    range,
    periods,
    snapshots,
  };
}

async function writeSiteData(siteData) {
  await writeJson(SITE_DATA_FILE, siteData);
}

module.exports = {
  DATA_DIR,
  DETAILS_FILE,
  DETAIL_DELAY_MS,
  EXPECTED_MODELS_PER_PAGE,
  GENERATED_DIR,
  LIST_PAGES,
  MAX_DETAILS_PER_RUN,
  PUBLIC_DIR,
  SITE_DATA_FILE,
  SNAPSHOTS_FILE,
  UNKNOWN_VALUE,
  aggregateSnapshots,
  buildSiteData,
  fetchCatalogModels,
  fetchModelDetails,
  getTodayKey,
  loadDetailsCache,
  loadSnapshots,
  normalizeModel,
  normalizeCategoryValue,
  normalizeWhitespace,
  saveDetailsCache,
  saveSnapshots,
  writeSiteData,
};
