// wallet-check.js — Meridian-OP. `walletAddress` (user-config / WALLET_ADDRESS) is the bot's OWN
// public address, used to READ positions and balances; transactions are SIGNED with
// WALLET_PRIVATE_KEY. If the two differ, exits/SL/kill switch watch a different wallet than the
// one holding the positions. This check runs at startup:
//   - mismatch + live      -> throw (refuse to start)
//   - mismatch + DRY_RUN   -> warning (shadow mode may legitimately watch a read-only wallet)
//   - walletAddress empty  -> fine (derived from the private key)

import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

/** Public key of WALLET_PRIVATE_KEY (base58 or JSON array), or null if unset/invalid. */
export function publicKeyFromSecret(secret) {
  if (!secret || typeof secret !== "string") return null;
  const t = secret.trim();
  try {
    const bytes = t.startsWith("[") ? Uint8Array.from(JSON.parse(t)) : bs58.decode(t);
    return Keypair.fromSecretKey(bytes).publicKey.toString();
  } catch {
    return null;
  }
}

/** Pure. Returns { ok, level: "ok"|"warn"|"error", message }. */
export function checkWalletConsistency({ walletAddress, privateKey, dryRun }) {
  const configured = typeof walletAddress === "string" ? walletAddress.trim() : "";
  if (!configured) return { ok: true, level: "ok", message: "walletAddress empty — using the private key's address" };
  const derived = publicKeyFromSecret(privateKey);
  if (!derived) {
    return dryRun
      ? { ok: true, level: "warn", message: `Read-only mode: watching ${configured.slice(0, 4)}…${configured.slice(-4)} (no usable WALLET_PRIVATE_KEY)` }
      : { ok: false, level: "error", message: "LIVE mode needs a valid WALLET_PRIVATE_KEY" };
  }
  if (derived === configured) return { ok: true, level: "ok", message: "walletAddress matches WALLET_PRIVATE_KEY" };
  const msg = `walletAddress ${configured.slice(0, 4)}…${configured.slice(-4)} does NOT match WALLET_PRIVATE_KEY's wallet ${derived.slice(0, 4)}…${derived.slice(-4)} — positions/balances would be read from a different wallet than the one trading. Empty walletAddress in user-config.json (and WALLET_ADDRESS in .env) or fix it.`;
  return dryRun ? { ok: true, level: "warn", message: msg } : { ok: false, level: "error", message: msg };
}
