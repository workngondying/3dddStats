const fs = require("fs/promises");
const path = require("path");
const { buildSiteData, loadSnapshots, writeSiteData } = require("./lib");

async function build() {
  const snapshots = await loadSnapshots();
  const siteData = buildSiteData(snapshots);
  await writeSiteData(siteData);
  await fs.writeFile(
    path.join(__dirname, "..", "public", "data", "site-data.js"),
    `window.__SITE_DATA__ = ${JSON.stringify(siteData, null, 2)};\n`,
    "utf8",
  );
  console.log("Built public/data/site-data.json");
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
