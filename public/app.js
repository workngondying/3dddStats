const fromInput = document.getElementById("from-date");
const toInput = document.getElementById("to-date");
const applyButton = document.getElementById("apply-button");
const collectButton = document.getElementById("collect-button");
const summaryNode = document.getElementById("summary");
const updatedNode = document.getElementById("updated-at");
const statusNode = document.getElementById("status");
const bodyNode = document.getElementById("models-body");
const rowTemplate = document.getElementById("row-template");
const presetButtons = [...document.querySelectorAll(".preset")];

let availableDates = [];

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
    return "Нет диапазона";
  }
  if (fromDate === toDate) {
    return `${fromDate} · ${snapshotCount} срез`;
  }
  return `${fromDate} - ${toDate} · ${snapshotCount} срезов`;
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
    modelMeta.textContent = `Лучшая позиция: #${model.bestRank} · Последняя страница: ${model.latestPage}`;

    row.querySelector(".published-at").textContent = model.publishedAt || "Не указана";
    row.querySelector(".category").textContent = model.category || "Не указана";
    row.querySelector(".points").textContent = model.totalPoints;
    row.querySelector(".appearances").textContent = model.appearances;

    bodyNode.appendChild(fragment);
  }
}

function setRange(days) {
  if (!availableDates.length) {
    return;
  }

  const max = availableDates[availableDates.length - 1];
  if (days === "all") {
    fromInput.value = availableDates[0];
    toInput.value = max;
    return;
  }

  const endDate = new Date(`${max}T00:00:00`);
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - (Number(days) - 1));
  const minAllowed = new Date(`${availableDates[0]}T00:00:00`);
  const finalStart = startDate < minAllowed ? minAllowed : startDate;
  fromInput.value = finalStart.toISOString().slice(0, 10);
  toInput.value = max;
}

async function loadModels({ refresh = false } = {}) {
  applyButton.disabled = true;
  collectButton.disabled = true;
  showStatus(refresh ? "Собираю свежий срез..." : "Загружаю данные...");

  try {
    const params = new URLSearchParams();
    if (fromInput.value) params.set("from", fromInput.value);
    if (toInput.value) params.set("to", toInput.value);
    if (refresh) params.set("refresh", "1");

    const response = await fetch(`/api/models?${params.toString()}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.details || payload.error || "Ошибка загрузки");
    }

    availableDates = payload.availableDates || [];
    if (!fromInput.value && payload.fromDate) fromInput.value = payload.fromDate;
    if (!toInput.value && payload.toDate) toInput.value = payload.toDate;

    renderRows(payload.models);
    summaryNode.textContent = `${formatPeriodText(payload.fromDate, payload.toDate, payload.snapshotCount)} · ${payload.count} моделей`;
    updatedNode.textContent = payload.latestCollectedAt ? `Последний сбор: ${formatDateTime(payload.latestCollectedAt)}` : "";

    if (payload.missingDetailsCount > 0) {
      showStatus(`У ${payload.missingDetailsCount} моделей ещё догружаются дата или категория. Оставьте сервер включённым, и поля постепенно заполнятся.`);
    } else {
      hideStatus();
    }
  } catch (error) {
    summaryNode.textContent = "Не удалось загрузить статистику";
    showStatus(error.message);
  } finally {
    applyButton.disabled = false;
    collectButton.disabled = false;
  }
}

applyButton.addEventListener("click", () => loadModels());
collectButton.addEventListener("click", () => loadModels({ refresh: true }));
presetButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setRange(button.dataset.days);
    loadModels();
  });
});

loadModels();
