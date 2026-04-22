const {
  DETAIL_DELAY_MS,
  MAX_DETAILS_PER_RUN,
  UNKNOWN_VALUE,
  fetchCatalogModels,
  fetchModelDetails,
  getTodayKey,
  loadDetailsCache,
  loadSnapshots,
  saveDetailsCache,
  saveSnapshots,
} = require("./lib");

function collectMissingCandidates(snapshots) {
  const byUrl = new Map();

  for (const snapshot of snapshots) {
    for (const model of snapshot.models || []) {
      const hasMissingDetails =
        model.category === UNKNOWN_VALUE || model.publishedAt === UNKNOWN_VALUE;

      if (!hasMissingDetails) {
        continue;
      }

      const existing = byUrl.get(model.url);
      if (!existing || snapshot.date >= existing.lastSeenAt) {
        byUrl.set(model.url, {
          ...model,
          lastSeenAt: snapshot.date,
        });
      }
    }
  }

  return [...byUrl.values()];
}

function pickModelsToEnrich(snapshots) {
  const candidates = collectMissingCandidates(snapshots);
  const groups = new Map();

  for (const model of candidates) {
    if (!groups.has(model.page)) {
      groups.set(model.page, []);
    }
    groups.get(model.page).push(model);
  }

  for (const models of groups.values()) {
    models.sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
  }

  const orderedPages = [...groups.keys()].sort((left, right) => left - right);
  const selected = [];

  while (selected.length < MAX_DETAILS_PER_RUN) {
    let pickedInRound = false;

    for (const page of orderedPages) {
      const models = groups.get(page);
      if (!models || !models.length) {
        continue;
      }

      selected.push(models.shift());
      pickedInRound = true;

      if (selected.length >= MAX_DETAILS_PER_RUN) {
        break;
      }
    }

    if (!pickedInRound) {
      break;
    }
  }

  return {
    selected,
    totalMissing: candidates.length,
  };
}

async function collectToday() {
  const [snapshots, detailsCache] = await Promise.all([loadSnapshots(), loadDetailsCache()]);
  const todayKey = getTodayKey();
  const todayModels = await fetchCatalogModels(detailsCache);

  const todaySnapshot = {
    date: todayKey,
    collectedAt: new Date().toISOString(),
    models: todayModels,
  };

  const nextSnapshots = [...snapshots.filter((snapshot) => snapshot.date !== todayKey), todaySnapshot];
  await saveSnapshots(nextSnapshots);

  const { selected: modelsToEnrich, totalMissing } = pickModelsToEnrich(nextSnapshots);

  for (const model of modelsToEnrich) {
    try {
      const details = await fetchModelDetails(model);
      detailsCache[model.url] = details;

      nextSnapshots.forEach((snapshot) => {
        snapshot.models = snapshot.models.map((entry) =>
          entry.url === model.url
            ? {
                ...entry,
                category: details.category || entry.category,
                publishedAt: details.publishedAt || entry.publishedAt,
              }
            : entry,
        );
      });

      await saveDetailsCache(detailsCache);
      await saveSnapshots(nextSnapshots);
      await new Promise((resolve) => setTimeout(resolve, DETAIL_DELAY_MS));
    } catch (error) {
      console.error(`Failed to fetch details for ${model.url}:`, error.message);
    }
  }

  console.log(
    `Collected snapshot for ${todayKey}. Enriched ${modelsToEnrich.length} of ${totalMissing} missing models.`,
  );
}

collectToday().catch((error) => {
  console.error(error);
  process.exit(1);
});
