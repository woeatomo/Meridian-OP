import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Keypair,
} from "@solana/web3.js";
import bs58 from "bs58";
import { rpcBalances, priceBalances } from "../standalone/balances.js";
import { log } from "../logger.js";
import { config } from "../config.js";
import { swapGuard } from "../modules/swap-guard.js";
import { rpcConnection } from "../modules/rpc-health.js";

let _connection = null;
let _wallet = null;

function getConnection() {
  // Meridian-OP: active endpoint from the RPC health monitor (primary / fallback).
  return rpcConnection("confirmed");
}

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const JUPITER_SWAP_V2_API = "https://api.jup.ag/swap/v2";
const DEFAULT_JUPITER_API_KEY = "b15d42e9-e0e4-4f90-a424-ae41ceeaa382";

function getJupiterApiKey() {
  return config.jupiter.apiKey || process.env.JUPITER_API_KEY || DEFAULT_JUPITER_API_KEY;
}

function getJupiterReferralParams() {
  const referralAccount = String(config.jupiter.referralAccount || "").trim();
  const referralFee = Number(config.jupiter.referralFeeBps || 0);
  if (!referralAccount || !Number.isFinite(referralFee) || referralFee <= 0) {
    return null;
  }
  if (referralFee < 50 || referralFee > 255) {
    log("swap_warn", `Ignoring Jupiter referral fee ${referralFee}; Ultra requires 50-255 bps`);
    return null;
  }
  try {
    new PublicKey(referralAccount);
  } catch {
    log("swap_warn", "Ignoring invalid Jupiter referral account");
    return null;
  }
  return { referralAccount, referralFee: Math.round(referralFee) };
}

/** Standard RPC balances; native SOL and wrapped SOL remain separate. */
export async function getWalletBalances(options = {}) {
  try {
    const walletAddress = config.standalone.walletAddress || getWallet().publicKey.toString();
    const raw = await rpcBalances(walletAddress, options);
    return options.nativeOnly ? raw : await priceBalances(raw);
  } catch (error) {
    return { wallet: null, sol: null, sol_price: null, sol_usd: null, usdc: null, tokens: [], total_usd: null, error: error.message };
  }
}

/**
 * Swap tokens via Jupiter Swap API V2 (order → sign → execute).
 */
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Normalize any SOL-like address to the correct wrapped SOL mint
export function normalizeMint(mint) {
  if (!mint) return mint;
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  if (
    mint === "SOL" || 
    mint === "native" || 
    /^So1+$/.test(mint) || 
    (mint.length >= 32 && mint.length <= 44 && mint.startsWith("So1") && mint !== SOL_MINT)
  ) {
    return SOL_MINT;
  }
  return mint;
}

/**
 * Price impact (in percent, absolute) from a Jupiter order/quote response.
 * Newer Ultra responses carry `priceImpact` already in percent; classic v6-style
 * quotes carry `priceImpactPct` as a FRACTION string ("0.0123" = 1.23%).
 * Returns null when the response has neither.
 */
export function parseOrderPriceImpactPct(order) {
  if (!order) return null;
  const pct = Number(order.priceImpact);
  if (order.priceImpact != null && Number.isFinite(pct)) return Math.abs(pct);
  const frac = Number(order.priceImpactPct);
  if (order.priceImpactPct != null && Number.isFinite(frac)) return Math.abs(frac * 100);
  return null;
}

export async function swapToken({
  input_mint,
  output_mint,
  amount,
  max_price_impact_pct = null, // Meridian-OP swap guard: refuse (before signing) above this impact
}) {
  input_mint  = normalizeMint(input_mint);
  output_mint = normalizeMint(output_mint);

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_swap: { input_mint, output_mint, amount },
      message: "DRY RUN — no transaction sent",
    };
  }

  try {
    log("swap", `${amount} of ${input_mint} → ${output_mint}`);
    const wallet = getWallet();
    const connection = getConnection();

    // ─── Convert to smallest unit ──────────────────────────────
    let decimals = 9; // SOL default
    if (input_mint !== config.tokens.SOL) {
      const mintInfo = await connection.getParsedAccountInfo(new PublicKey(input_mint));
      decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    }
    const amountStr = Math.floor(amount * Math.pow(10, decimals)).toString();

    // ─── Get Swap V2 order (unsigned tx + requestId) ───────────
    const search = new URLSearchParams({
      inputMint: input_mint,
      outputMint: output_mint,
      amount: amountStr,
      taker: wallet.publicKey.toString(),
    });
    const referralParams = getJupiterReferralParams();
    if (referralParams) {
      search.set("referralAccount", referralParams.referralAccount);
      search.set("referralFee", String(referralParams.referralFee));
    }
    const orderUrl = `${JUPITER_SWAP_V2_API}/order?${search.toString()}`;
    const jupiterApiKey = getJupiterApiKey();

    const orderRes = await fetch(orderUrl, {
      headers: jupiterApiKey ? { "x-api-key": jupiterApiKey } : {},
    });
    if (!orderRes.ok) {
      const body = await orderRes.text();
      throw new Error(`Swap V2 order failed: ${orderRes.status} ${body}`);
    }

    const order = await orderRes.json();
    if (order.errorCode || order.errorMessage) {
      throw new Error(`Swap V2 order error: ${order.errorMessage || order.errorCode}`);
    }

    // ─── Swap guard: price impact check before signing ─────────
    const priceImpactPct = parseOrderPriceImpactPct(order);
    if (max_price_impact_pct != null && Number.isFinite(Number(max_price_impact_pct))) {
      const guard = swapGuard({ priceImpactPct, maxPriceImpactPct: Number(max_price_impact_pct) });
      if (!guard.allow) {
        log("swap_warn", `Swap guard blocked ${input_mint.slice(0, 8)} → ${output_mint.slice(0, 8)}: ${guard.reason}`);
        return { success: false, blocked: true, reason: guard.reason, price_impact_pct: priceImpactPct, input_mint, output_mint };
      }
    }

    const { transaction: unsignedTx, requestId } = order;

    // ─── Deserialize and sign ─────────────────────────────────
    const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTx, "base64"));
    tx.sign([wallet]);
    const signedTx = Buffer.from(tx.serialize()).toString("base64");

    // ─── Execute ───────────────────────────────────────────────
    const execRes = await fetch(`${JUPITER_SWAP_V2_API}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(jupiterApiKey ? { "x-api-key": jupiterApiKey } : {}),
      },
      body: JSON.stringify({ signedTransaction: signedTx, requestId }),
    });
    if (!execRes.ok) {
      throw new Error(`Swap V2 execute failed: ${execRes.status} ${await execRes.text()}`);
    }

    const result = await execRes.json();
    if (result.status === "Failed") {
      throw new Error(`Swap failed on-chain: code=${result.code}`);
    }

    log("swap", `SUCCESS tx: ${result.signature}`);
    if (referralParams && order.feeBps !== referralParams.referralFee) {
      log(
        "swap_warn",
        `Jupiter referral fee requested ${referralParams.referralFee} bps but order applied ${order.feeBps ?? "unknown"} bps`,
      );
    }

    return {
      success: true,
      tx: result.signature,
      input_mint,
      output_mint,
      amount_in: result.inputAmountResult,
      amount_out: result.outputAmountResult,
      referral_account: referralParams?.referralAccount || null,
      referral_fee_bps_requested: referralParams?.referralFee || 0,
      fee_bps_applied: order.feeBps ?? null,
      price_impact_pct: priceImpactPct,
      fee_mint: order.feeMint ?? null,
    };
  } catch (error) {
    log("swap_error", error.message);
    return { success: false, error: error.message };
  }
}
