#!/usr/bin/env node
// init-config.js — Meridian-OP. Build user-config.json from the templates.
//
//   node scripts/init-config.js            create user-config.json (or add missing keys to an existing one)
//   node scripts/init-config.js --dry-run  show what would change, write nothing
//
// Layers (later wins): user-config.example.json  <  user-config.p0-p1.json  <  your existing user-config.json
// - Your existing values are NEVER overwritten; only keys you don't have yet are added.
// - RPC keys (rpcUrl, pnlRpcUrl, monitor/balance/fallback RPC) are dropped: RPC lives in rpc-endpoints.json.
// - A NEW file always starts with shadowMode: true (no real transactions until you flip it).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = (f) => path.join(root, f);
const dryRun = process.argv.includes("--dry-run");

const RPC_KEYS = ["rpcUrl", "pnlRpcUrl", "monitorRpcUrl", "monitorWsUrl", "balanceRpcUrl", "fallbackRpcUrl"];
const META_KEYS = ["_readme", "_comment"];

function readJson(file, required = true) {
  if (!fs.existsSync(file)) {
    if (required) throw new Error(`${path.basename(file)} not found`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${path.basename(file)} is not valid JSON: ${e.message}`);
  }
}

/** Pure merge. Returns { result, added, kept, dropped }. */
export function buildUserConfig(base, overlay, existing) {
  const strip = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => !META_KEYS.includes(k)));
  const template = { ...strip(base), ...strip(overlay) };
  for (const k of RPC_KEYS) delete template[k];
  if (!existing) {
    template.shadowMode = true;
    return { result: template, added: Object.keys(template), kept: [], dropped: [] };
  }
  const result = { ...existing };
  const added = [];
  for (const [k, v] of Object.entries(template)) {
    if (!(k in result)) { result[k] = v; added.push(k); }
  }
  const dropped = RPC_KEYS.filter((k) => k in result && result[k] !== "" && result[k] != null);
  return { result, added, kept: Object.keys(existing), dropped };
}

function main() {
  const base = readJson(p("user-config.example.json"));
  const overlay = readJson(p("user-config.p0-p1.json"));
  const target = p("user-config.json");
  const existing = readJson(target, false);
  const { result, added, dropped } = buildUserConfig(base, overlay, existing);

  if (existing) {
    console.log(`user-config.json exists — keeping all ${Object.keys(existing).length} of your values.`);
    console.log(added.length ? `Adding ${added.length} missing key(s): ${added.join(", ")}` : "No missing keys — nothing to add.");
    if (dropped.length) {
      console.log(`\nNOTE: your file still sets ${dropped.join(", ")}. RPC now lives in rpc-endpoints.json;`);
      console.log("remove these keys so rpc-endpoints.json is used (rpcUrl would otherwise stay first in priority).");
    }
    if (existing.stopLossPct != null && existing.stopLossPct < -20) {
      console.log(`\nNOTE: stopLossPct is ${existing.stopLossPct}. The Meridian-OP spec uses -15.`);
    }
  } else {
    console.log(`Creating user-config.json with ${added.length} keys (template + Meridian-OP), shadowMode: true.`);
  }

  if (dryRun) { console.log("\n--dry-run: nothing written."); return; }
  if (existing && !added.length) return;
  if (existing) fs.copyFileSync(target, `${target}.bak`);
  fs.writeFileSync(target, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  console.log(`\nWrote user-config.json${existing ? " (backup: user-config.json.bak)" : ""}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(`init-config: ${e.message}`); process.exit(1); }
}
