const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const LIST_PAGES = [1, 2, 3, 4, 5];
const REQUEST_TIMEOUT_MS = 30000;
const MAX_FETCH_RETRIES = 3;
const UNKNOWN_VALUE = "Не указана";
const HOURLY_CHECK_MS = 60 * 60 * 1000;
const DETAIL_LOOP_DELAY_MS = 7000;

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const DATA_DIR = path.join(ROOT_DIR, "data");
const SNAPSHOTS_FILE = path.join(DATA_DIR, "snapshots.json");
const DETAILS_FILE = path.join(DATA_DIR, "details-cache.json");
const LEGACY_CACHE_FILE = path.join(DATA_DIR, "models-cache.json");
const EDGE_PATH = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const state = {
  snapshots: [],
  detailsCache: {},
  collectPromise: null,
  backfillStarted: false,
};

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function toProxyUrl(targetUrl) {
  return `https://r.jina.ai/http://${targetUrl.replace(/^https?:\/\//, "")}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureDataDir() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    const file = await fsp.readFile(filePath, "utf8");
    return JSON.parse(file);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error(`Failed to read ${filePath}:`, error);
    }
    return fallback;
  }
}

async function writeJson(filePath, payload) {
  await ensureDataDir();
  await fsp.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
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

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function extractCatalogSection(markdown) {
  const startIndex = markdown.indexOf("Найдено");
  const endCandidates = [
    markdown.indexOf("[Следующая страница]"),
    markdown.indexOf("Всего "),
  ].filter((value) => value >= 0);

  if (startIndex === -1) {
    return markdown;
  }

  if (!endCandidates.length) {
    return markdown.slice(startIndex);
  }

  return markdown.slice(startIndex, Math.min(...endCandidates));
}

function parseListPage(markdown, pageNumber) {
  const section = extractCatalogSection(markdown);
  const itemRegex =
    /\[!\[Image\s+\d+(?::\s*([^\]]*))?\]\((https?:\/\/[^\s)]+)\)\]\((https:\/\/3ddd\.ru\/3dmodels\/show\/[^)]+)\)/g;

  const models = [];
  let match;

  while ((match = itemRegex.exec(section)) !== null) {
    const rawTitle = match[1] || "";
    const imageUrl = match[2];
    const url = match[3];
    const title = normalizeWhitespace(rawTitle.replace(/\\/g, "")) || "Без названия";

    models.push({
      title,
      url,
      imageUrl,
      page: pageNumber,
      points: Math.max(1, 6 - pageNumber),
      category: UNKNOWN_VALUE,
      publishedAt: UNKNOWN_VALUE,
    });
  }

  const unique = new Map();
  for (const model of models) {
    if (!unique.has(model.url)) {
      unique.set(model.url, model);
    }
  }

  return Array.from(unique.values());
}

function parseCategory(markdown) {
  const categoryRegex = /\[([^\]]+)\]\(https:\/\/3ddd\.ru\/3dmodels\?(?:subcat=[^)\s]+&)?cat=[^)\s]+\)/g;
  const categories = [];
  let match;

  while ((match = categoryRegex.exec(markdown)) !== null) {
    const category = normalizeWhitespace(match[1]);
    if (category && !categories.includes(category)) {
      categories.push(category);
    }
  }

  if (!categories.length) {
    const titleMatch = markdown.match(/^Title:\s+(.+?)\s+-\s+3D модель/m);
    if (titleMatch) {
      const parts = titleMatch[1].split(" - ").map((part) => normalizeWhitespace(part));
      if (parts.length >= 2) {
        return parts.slice(1).join(" / ");
      }
    }
    return UNKNOWN_VALUE;
  }

  return categories.slice(0, 2).join(" / ");
}

function parsePublishedAt(markdown) {
  const match = markdown.match(/Опубликована\s+([0-9]{1,2}\s+[\p{L}]+\s+\d{4})/u);
  return match ? normalizeWhitespace(match[1]) : UNKNOWN_VALUE;
}

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

function sortSnapshots(list) {
  return [...list].sort((a, b) => a.date.localeCompare(b.date));
}

function getSnapshotByDate(date) {
  return state.snapshots.find((snapshot) => snapshot.date === date) || null;
}

function mergeDetailsIntoModel(model) {
  const details = state.detailsCache[model.url];
  if (!details) {
    return model;
  }

  return {
    ...model,
    category: details.category || model.category || UNKNOWN_VALUE,
    publishedAt: details.publishedAt || model.publishedAt || UNKNOWN_VALUE,
  };
}

function patchAllSnapshotsForUrl(url, details) {
  let changed = false;
  state.snapshots = state.snapshots.map((snapshot) => {
    let snapshotChanged = false;
    const models = snapshot.models.map((model) => {
      if (model.url !== url) {
        return model;
      }

      const nextModel = {
        ...model,
        category: details.category || model.category || UNKNOWN_VALUE,
        publishedAt: details.publishedAt || model.publishedAt || UNKNOWN_VALUE,
      };

      if (
        nextModel.category !== model.category ||
        nextModel.publishedAt !== model.publishedAt
      ) {
        snapshotChanged = true;
        changed = true;
      }

      return nextModel;
    });

    return snapshotChanged ? { ...snapshot, models } : snapshot;
  });

  return changed;
}

async function saveState() {
  await Promise.all([
    writeJson(SNAPSHOTS_FILE, state.snapshots),
    writeJson(DETAILS_FILE, state.detailsCache),
  ]);
}

function migrateLegacyPayload(legacyPayload) {
  if (!legacyPayload || !Array.isArray(legacyPayload.models) || !legacyPayload.models.length || !legacyPayload.fetchedAt) {
    return;
  }

  const dateKey = String(legacyPayload.fetchedAt).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || getSnapshotByDate(dateKey)) {
    return;
  }

  const snapshot = {
    date: dateKey,
    collectedAt: legacyPayload.fetchedAt,
    models: legacyPayload.models.map((model) => ({
      title: model.title,
      url: model.url,
      imageUrl: model.imageUrl,
      page: model.page,
      points: model.points,
      category: model.category || UNKNOWN_VALUE,
      publishedAt: model.publishedAt || UNKNOWN_VALUE,
    })),
  };

  state.snapshots = sortSnapshots([...state.snapshots, snapshot]);
}
async function loadState() {
  state.snapshots = sortSnapshots(await readJson(SNAPSHOTS_FILE, []));
  state.detailsCache = await readJson(DETAILS_FILE, {});
  const legacyPayload = await readJson(LEGACY_CACHE_FILE, null);
  migrateLegacyPayload(legacyPayload);
  await saveState();
}

async function fetchCatalogModels() {
  const pageMarkdowns = await Promise.all(
    LIST_PAGES.map((pageNumber) =>
      fetchText(toProxyUrl(`https://3ddd.ru/3dmodels?order=sell_rating&page=${pageNumber}`)),
    ),
  );

  return pageMarkdowns.flatMap((markdown, index) =>
    parseListPage(markdown, LIST_PAGES[index]).map(mergeDetailsIntoModel),
  );
}

async function collectSnapshot({ force = false, dateKey = getTodayKey() } = {}) {
  if (!state.collectPromise) {
    state.collectPromise = (async () => {
      try {
        if (!force) {
          const existing = getSnapshotByDate(dateKey);
          if (existing) {
            return existing;
          }
        }

        const models = await fetchCatalogModels();
        const snapshot = {
          date: dateKey,
          collectedAt: new Date().toISOString(),
          models,
        };

        const withoutDate = state.snapshots.filter((item) => item.date !== dateKey);
        state.snapshots = sortSnapshots([...withoutDate, snapshot]);
        await saveState();
        return snapshot;
      } finally {
        state.collectPromise = null;
      }
    })();
  }

  return state.collectPromise;
}

async function fetchModelDetailsFromProxy(model) {
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

async function backfillMissingDetailsLoop() {
  if (state.backfillStarted) {
    return;
  }

  state.backfillStarted = true;

  while (true) {
    try {
      const queue = [];
      const seen = new Set();

      for (const snapshot of state.snapshots) {
        for (const model of snapshot.models) {
          const cached = state.detailsCache[model.url];
          const hasDetails = cached && cached.category && cached.category !== UNKNOWN_VALUE && cached.publishedAt && cached.publishedAt !== UNKNOWN_VALUE;
          if (!hasDetails && !seen.has(model.url)) {
            seen.add(model.url);
            queue.push(model);
          }
        }
      }

      if (!queue.length) {
        await sleep(15000);
        continue;
      }

      const nextModel = queue[0];

      try {
        const details = await fetchModelDetailsFromProxy(nextModel);
        state.detailsCache[nextModel.url] = {
          ...state.detailsCache[nextModel.url],
          ...details,
        };
        patchAllSnapshotsForUrl(nextModel.url, details);
        await saveState();
      } catch (error) {
        console.error(`Detail backfill failed for ${nextModel.url}:`, error.message);
      }
    } catch (error) {
      console.error("Background detail loop failed:", error);
    }

    await sleep(DETAIL_LOOP_DELAY_MS);
  }
}

function normalizeDateInput(value) {
  if (!value) {
    return null;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function getAvailableDateRange() {
  if (!state.snapshots.length) {
    return { min: null, max: null };
  }

  return {
    min: state.snapshots[0].date,
    max: state.snapshots[state.snapshots.length - 1].date,
  };
}

function aggregateSnapshots(fromDate, toDate) {
  const filtered = state.snapshots.filter((snapshot) => {
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
      const existing = byUrl.get(model.url);
      const rank = index + 1;
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

  const missingDetailsCount = models.filter(
    (model) => model.category === UNKNOWN_VALUE || model.publishedAt === UNKNOWN_VALUE,
  ).length;

  return {
    fromDate,
    toDate,
    snapshotCount: filtered.length,
    count: models.length,
    missingDetailsCount,
    models,
  };
}

async function getPayload({ fromDate, toDate, refresh = false } = {}) {
  if (!state.snapshots.length || refresh) {
    await collectSnapshot({ force: refresh });
  } else {
    const todayKey = getTodayKey();
    if (!getSnapshotByDate(todayKey)) {
      await collectSnapshot({ dateKey: todayKey });
    }
  }

  const range = getAvailableDateRange();
  const effectiveFrom = normalizeDateInput(fromDate) || range.max;
  const effectiveTo = normalizeDateInput(toDate) || range.max;
  const normalizedFrom = effectiveFrom && effectiveTo && effectiveFrom > effectiveTo ? effectiveTo : effectiveFrom;
  const normalizedTo = effectiveFrom && effectiveTo && effectiveFrom > effectiveTo ? effectiveFrom : effectiveTo;
  const aggregated = aggregateSnapshots(normalizedFrom, normalizedTo);

  return {
    ...aggregated,
    availableDates: state.snapshots.map((snapshot) => snapshot.date),
    latestCollectedAt: state.snapshots[state.snapshots.length - 1]?.collectedAt || null,
  };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": MIME_TYPES[".json"],
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

async function serveStaticFile(requestPath, response) {
  const normalizedPath = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, normalizedPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) {
      throw new Error("Not a file");
    }

    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
    });
    fs.createReadStream(filePath).pipe(response);
  } catch (error) {
    sendJson(response, 404, { error: "Not found" });
  }
}

async function requestHandler(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (request.method === "GET" && requestUrl.pathname === "/api/models") {
    try {
      const payload = await getPayload({
        fromDate: requestUrl.searchParams.get("from"),
        toDate: requestUrl.searchParams.get("to"),
        refresh: requestUrl.searchParams.get("refresh") === "1",
      });
      sendJson(response, 200, payload);
    } catch (error) {
      console.error("Failed to build payload:", error);
      sendJson(response, 500, {
        error: "Не удалось загрузить модели.",
        details: error.message,
      });
    }
    return;
  }

  if (request.method === "GET") {
    await serveStaticFile(requestUrl.pathname, response);
    return;
  }

  response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Method Not Allowed");
}

async function ensureTodaySnapshot() {
  const todayKey = getTodayKey();
  if (!getSnapshotByDate(todayKey)) {
    await collectSnapshot({ dateKey: todayKey });
  }
}

async function bootstrap() {
  await loadState();
  await ensureTodaySnapshot();
  backfillMissingDetailsLoop().catch((error) => {
    console.error("Backfill loop crashed:", error);
  });

  setInterval(() => {
    ensureTodaySnapshot().catch((error) => {
      console.error("Scheduled collection failed:", error);
    });
  }, HOURLY_CHECK_MS);

  const server = http.createServer((request, response) => {
    requestHandler(request, response).catch((error) => {
      console.error("Unhandled request error:", error);
      sendJson(response, 500, { error: "Внутренняя ошибка сервера." });
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`SiteStat is running on http://${HOST}:${PORT}`);
  });
}

if (process.argv.includes("--collect")) {
  loadState()
    .then(() => collectSnapshot({ force: true }))
    .then(async () => {
      await saveState();
      console.log("Snapshot collected.");
      process.exit(0);
    })
    .catch((error) => {
      console.error("Collect failed:", error);
      process.exit(1);
    });
} else {
  bootstrap().catch((error) => {
    console.error("Failed to start server:", error);
    process.exitCode = 1;
  });
}




