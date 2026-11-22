#!/usr/bin/env node
// init-op.js — Meridian-OP first-time setup for a (new) VPS.
//
//   npm run init:op              create / update config files
//   npm run init:op -- --dry-run show what would change, write nothing
//
// 1. user-config.json
//    - missing  -> user-config.example.json + user-config.p0-p1.json (p0-p1 wins on conflicts)
//    - existing -> only ADD keys from p0-p1 that are missing; your current values are kept.
//                  A timestamped backup is written first.
//    RPC keys (rpcUrl, pnlRpcUrl, monitorRpcUrl, balanceRpcUrl, fallbackRpcUrl) are never copied
//    from the templates: RPC lives in rpc-endpoints.json. Existing ones are reported (keep
//    them only if you really want a fixed RPC — rpcUrl would override rpc-endpoints.json).
// 2. rpc-endpoints.json  — created from rpc-endpoints.example.json if missing (chmod 600).
// 3. smart-wallets.json  — created empty if missing.
// Never reads or writes .env (secrets stay where you put them).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = (f) => path.join(ROOT, f);
const DRY = process.argv.includes("--dry-run");
const RPC_KEYS = ["rpcUrl", "pnlRpcUrl", "monitorRpcUrl", "balanceRpcUrl", "fallbackRpcUrl"];

const readJson = (f) => JSON.parse(fs.readFileSync(p(f), "utf8"));
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
function write(f, data, mode = 0o600) {
  if (DRY) return;
  fs.writeFileSync(p(f), typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n", { mode });
  fs.chmodSync(p(f), mode);
}
const strip = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith("_") && !RPC_KEYS.includes(k)));

const notes = [];

// ── 1. user-config.json ──────────────────────────────────────────────
const example = strip(readJson("user-config.example.json"));
const op = strip(readJson("user-config.p0-p1.json"));
if (!fs.existsSync(p("user-config.json"))) {
  const merged = { ...example, ...op };
  merged.shadowMode = true; // always start in shadow mode on a new box
  write("user-config.json", merged);
  const overridden = Object.keys(op).filter((k) => k in example && example[k] !== op[k]);
  notes.push(`user-config.json created (${Object.keys(merged).length} keys, shadowMode: true).`);
  if (overridden.length) notes.push(`  Meridian-OP values used instead of example: ${overridden.map((k) => `${k}=${JSON.stringify(op[k])}`).join(", ")}`);
} else {
  const current = readJson("user-config.json");
  const missing = Object.keys(op).filter((k) => !(k in current));
  const differs = Object.keys(op).filter((k) => k in current && JSON.stringify(current[k]) !== JSON.stringify(op[k]));
  if (missing.length) {
    if (!DRY) fs.copyFileSync(p("user-config.json"), p(`user-config.json.bak-${stamp()}`));
    write("user-config.json", { ...current, ...Object.fromEntries(missing.map((k) => [k, op[k]])) });
    notes.push(`user-config.json: added ${missing.length} Meridian-OP key(s) (backup saved): ${missing.join(", ")}`);
  } else {
    notes.push("user-config.json: already has every Meridian-OP key.");
  }
  if (differs.length) notes.push(`  Kept your values (Meridian-OP default differs): ${differs.map((k) => `${k}: yours=${JSON.stringify(current[k])} op=${JSON.stringify(op[k])}`).join("; ")}`);
  const rpcLeft = RPC_KEYS.filter((k) => current[k]);
  if (rpcLeft.length) notes.push(`  ⚠ RPC keys still in user-config.json: ${rpcLeft.join(", ")} — remove them to let rpc-endpoints.json control RPC (rpcUrl overrides it).`);
}

// ── 2. rpc-endpoints.json ────────────────────────────────────────────
if (!fs.existsSync(p("rpc-endpoints.json"))) {
  write("rpc-endpoints.json", fs.readFileSync(p("rpc-endpoints.example.json"), "utf8"));
  notes.push("rpc-endpoints.json created from the example (chmod 600) — fill in your apiKey values.");
} else {
  notes.push("rpc-endpoints.json: exists, left unchanged.");
}

// ── 3. smart-wallets.json ────────────────────────────────────────────
if (!fs.existsSync(p("smart-wallets.json"))) {
  write("smart-wallets.json", { wallets: [] }, 0o644);
  notes.push("smart-wallets.json created (empty) — standalone needs >= 2 lp wallets: node cli.js wallets add --address <ADDR> --name <NAME>");
} else {
  const n = (readJson("smart-wallets.json").wallets || []).filter((w) => !w.type || w.type === "lp").length;
  notes.push(`smart-wallets.json: ${n} lp wallet(s)${n < 2 ? " — standalone needs at least 2" : ""}.`);
}

console.log(`${DRY ? "[dry-run] " : ""}Meridian-OP init\n`);
for (const n of notes) console.log(n);
console.log(`
Still to do by hand:
  1. .env: WALLET_PRIVATE_KEY, OPENROUTER_API_KEY (or LLM_API_KEY), TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
     (no RPC_URL / HELIUS_API_KEY needed — RPC is in rpc-endpoints.json)
  2. rpc-endpoints.json: your apiKey values, then: node cli.js rpc
  3. smart wallets: node cli.js wallets add --address <ADDR> --name <NAME>   (>= 2)
  4. start in shadow mode, watch logs, only then set shadowMode: false`);
