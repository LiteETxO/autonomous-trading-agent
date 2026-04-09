/**
 * register-position.js
 * Lightweight position registry — no heavy deps.
 * Agent writes here; position-monitor reads here.
 */

import fs   from "fs";
import path from "path";

const REGISTRY_PATH = "./data/open-positions.json";

function loadRegistry() {
  if (!fs.existsSync(REGISTRY_PATH)) return { positions: [] };
  try { return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8")); }
  catch { return { positions: [] }; }
}

function saveRegistry(reg) {
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2));
}

export function registerPosition(pos) {
  const reg = loadRegistry();
  reg.positions.push({
    id:           pos.id || `pos-${Date.now()}`,
    venue:        pos.venue,
    symbol:       pos.symbol,
    side:         pos.side,
    strategy:     pos.strategy || null,
    score:        pos.score    || null,
    entryPrice:   pos.entryPrice,
    sizeUsd:      pos.sizeUsd,
    stopPrice:    pos.stopPrice,
    tpPrice:      pos.tpPrice,
    venueOrderId: pos.venueOrderId || null,
    openedAt:     new Date().toISOString(),
    status:       "open",
  });
  saveRegistry(reg);
}
