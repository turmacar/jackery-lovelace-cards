// HACS registers only one resource per repo, so this entry point loads every card.
// Forwarding this module's query string (HACS's ?hacstag=) cache-busts the card files on update.
const VERSION = "1.0.0";
console.info(`%c jackery-lovelace-cards %c ${VERSION} `, "background:#f39c12;color:#fff", "background:#ddd;color:#000");

const CARDS = [
  "jackery-ts-plan-card.js",
  "jackery-circuit-panel.js",
  "jackery-schedule-heatmap.js",
  "jackery-power-status-card.js",
  "jackery-battery-pack-card.js",
  "jackery-portable-card.js",
];

const query = new URL(import.meta.url).search;
for (const card of CARDS) {
  import(`./${card}${query}`).catch((err) =>
    console.error(`jackery-lovelace-cards: failed to load ${card}`, err)
  );
}
