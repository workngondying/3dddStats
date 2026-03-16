const { buildSiteData, loadSnapshots, writeSiteData } = require("./lib");

async function build() {
  const snapshots = await loadSnapshots();
  const siteData = buildSiteData(snapshots);
  await writeSiteData(siteData);
  console.log("Built public/data/site-data.json");
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
