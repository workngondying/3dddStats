const UNKNOWN_VALUE = "\u041d\u0435 \u0443\u043a\u0430\u0437\u0430\u043d\u0430";

const fromInput = document.getElementById("from-date");
const toInput = document.getElementById("to-date");
const applyButton = document.getElementById("apply-button");
const summaryNode = document.getElementById("summary");
const updatedNode = document.getElementById("updated-at");
const statusNode = document.getElementById("status");
const bodyNode = document.getElementById("models-body");
const rowTemplate = document.getElementById("row-template");
const presetButtons = [...document.querySelectorAll(".preset")];

let siteData = null;

function showStatus(message) {
  statusNode.textContent = message;
  statusNode.classList.add("visible");
}

function hideStatus() {
  statusNode.textContent = "";
  statusNode.classList.remove("visible");
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(date);
}

function formatPeriodText(fromDate, toDate, snapshotCount) {
  if (!fromDate || !toDate) {
    return "\u041d\u0435\u0442 \u0434\u0438\u0430\u043f\u0430\u0437\u043e\u043d\u0430";
  }
  if (fromDate === toDate) {
    return `${fromDate} · ${snapshotCount} \u0441\u0440\u0435\u0437`;
  }
  return `${fromDate} - ${toDate} · ${snapshotCount} \u0441\u0440\u0435\u0437\u043e\u0432`;
}

function renderRows(models) {
  bodyNode.textContent = "";

  for (const model of models) {
    const fragment = rowTemplate.content.cloneNode(true);
    const row = fragment.querySelector("tr");
    row.querySelector(".rank").textContent = model.rank;

    const thumbLink = row.querySelector(".thumb-link");
    const thumb = row.querySelector(".thumb");
    const modelLink = row.querySelector(".model-link");
    const modelMeta = row.querySelector(".model-meta");

    thumbLink.href = model.url;
    thumb.src = model.imageUrl;
    thumb.alt = model.title;
    modelLink.href = model.url;
    modelLink.textContent = model.title;
    modelMeta.textContent =
      `\u041b\u0443\u0447\u0448\u0430\u044f \u043f\u043e\u0437\u0438\u0446\u0438\u044f: #${model.bestRank} · ` +
      `\u041f\u043e\u0441\u043b\u0435\u0434\u043d\u044f\u044f \u0441\u0442\u0440\u0430\u043d\u0438\u0446\u0430: ${model.latestPage}`;

    row.querySelector(".published-at").textContent = model.publishedAt || UNKNOWN_VALUE;
    row.querySelector(".category").textContent = model.category || UNKNOWN_VALUE;
    row.querySelector(".points").textContent = model.totalPoints;
    row.querySelector(".appearances").textContent = model.appearances;

    bodyNode.appendChild(fragment);
  }
}

function aggregateSnapshots(fromDate, toDate) {
  const filtered = siteData.snapshots.filter((snapshot) => {
    if (fromDate && snapshot.date < fromDate) return false;
    if (toDate && snapshot.date > toDate) return false;
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
      if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
      if (b.appearances !== a.appearances) return b.appearances - a.appearances;
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

function setRange(days) {
  const dates = siteData.availableDates || [];
  if (!dates.length) return;

  const max = dates[dates.length - 1];

  if (days === "all") {
    fromInput.value = dates[0];
    toInput.value = max;
    return;
  }

  const endDate = new Date(`${max}T00:00:00`);
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - (Number(days) - 1));
  const minAllowed = new Date(`${dates[0]}T00:00:00`);
  const finalStart = startDate < minAllowed ? minAllowed : startDate;

  fromInput.value = finalStart.toISOString().slice(0, 10);
  toInput.value = max;
}

function applyRange() {
  const fromDate = fromInput.value || siteData.range.max;
  const toDate = toInput.value || siteData.range.max;
  const normalizedFrom = fromDate > toDate ? toDate : fromDate;
  const normalizedTo = fromDate > toDate ? fromDate : toDate;
  const payload = aggregateSnapshots(normalizedFrom, normalizedTo);

  renderRows(payload.models);
  summaryNode.textContent =
    `${formatPeriodText(payload.fromDate, payload.toDate, payload.snapshotCount)} · ` +
    `${payload.count} \u043c\u043e\u0434\u0435\u043b\u0435\u0439`;
  updatedNode.textContent = siteData.latestCollectedAt
    ? `\u041f\u043e\u0441\u043b\u0435\u0434\u043d\u0438\u0439 \u0441\u0431\u043e\u0440: ${formatDateTime(siteData.latestCollectedAt)}`
    : "";

  if (payload.missingDetailsCount > 0) {
    showStatus(
      `\u0423 ${payload.missingDetailsCount} \u043c\u043e\u0434\u0435\u043b\u0435\u0439 \u043f\u043e\u043a\u0430 \u043d\u0435\u0442 ` +
        `\u0434\u0430\u0442\u044b \u0438\u043b\u0438 \u043a\u0430\u0442\u0435\u0433\u043e\u0440\u0438\u0438 \u0432 \u0430\u0440\u0445\u0438\u0432\u0435.`,
    );
  } else {
    hideStatus();
  }
}

async function init() {
  try {
    const response = await fetch("./data/site-data.json", { cache: "no-store" });
    siteData = await response.json();

    fromInput.value = siteData.range.max || "";
    toInput.value = siteData.range.max || "";
    applyRange();
  } catch (error) {
    summaryNode.textContent =
      "\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044c \u0434\u0430\u043d\u043d\u044b\u0435 \u0441\u0430\u0439\u0442\u0430";
    showStatus(error.message);
  }
}

applyButton.addEventListener("click", applyRange);
presetButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setRange(button.dataset.days);
    applyRange();
  });
});

init();
