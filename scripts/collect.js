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

  const missingModels = todayModels.filter(
    (model) => model.category === UNKNOWN_VALUE || model.publishedAt === UNKNOWN_VALUE,
  );
  const modelsToEnrich = missingModels.slice(0, MAX_DETAILS_PER_RUN);

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
    `Collected snapshot for ${todayKey}. Enriched ${modelsToEnrich.length} of ${missingModels.length} missing models.`,
  );
}

collectToday().catch((error) => {
  console.error(error);
  process.exit(1);
});
