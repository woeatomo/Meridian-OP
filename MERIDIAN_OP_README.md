# Push bundle — Bot LP baru, scope P0 + P1
Dipilih Atomo 20 Nov 2026, 17:01 WIB. Basis: Meridian legacy commit e80077f (clone di `../meridian-legacy/`).
Status: SIAP DICEK, BELUM DI-PUSH ke repo Atomo (repo tujuan belum diberikan). JANGAN live.

## Isi bundle
- `user-config.p0-p1.json` — hanya key yang berubah / baru. Gabungkan ke `user-config.json` milik Atomo (jangan timpa file aslinya; jangan paste `walletKey` / API key ke mana pun).
- `patches/01-llm-reasoning-effort.patch` — agent.js + config.js. Reasoning effort per peran, fallback model diganti dari `stepfun/step-3.5-flash:free` ke DeepSeek V4.1 Flash 1017, provider routing dipin ke DeepSeek.
- `patches/02-exit-rules-emergency-oor.patch` — exit-rules.js + config.js. Emergency SL -10% + dump terkonfirmasi, SL normal -15%, OOR kanan kondisional PnL, guard max wait / max jarak.
- `modules/regime-gate.js` — P0 B1. Pure function, tanpa LLM, tanpa I/O.
- `modules/wallet-score.js` — P0 B2. Skor wallet 0-100.
- `modules/reshape-manager.js` — Reshape satu arah ke bawah (Spot -> Bid-Ask), + Emergency SL override.
- `modules/portfolio-guard.js` — P0 B3 + P1 C2. Daily loss limit, kill switch, max hold / fee decay.
- `modules/partial-tp.js` — P0 B5. Helper partial TP (50% di +5%, 25% lagi di +10%). STAGED: executor `close_position` Meridian saat ini hanya CLOSE semua — perlu penambahan parameter `fraction` di `tools/dlmm.js` / `standalone/monitor.js` sebelum fungsi ini dipakai live.
- `modules/fee-harvest.js` — P1 C1. Aturan klaim + auto-compound (pure decision, bukan eksekusi swap).
- `modules/sizing.js` — P1 C3. Sizing berdasarkan confidence.
- `modules/swap-guard.js` — P1 C4. Cek price impact / slippage sebelum swap.
- `modules/health.js` — P1 C5. RPC failover + alert event (interface, bukan Telegram sender baru).

## Yang BELUM di bundle ini (sengaja, butuh data live / backtest dulu)
- Backtest Engine (P0 B6): simulator DLMM historis. Tidak ada di Meridian; harus dibangun terpisah dari data Meteora/GMGN, lalu hasilnya menentukan angka final reshape 5 vs 10 bin, Emergency SL -10% vs -12%, OOR max wait 4 vs 6 jam. Angka di bundle ini adalah titik awal Atomo, bukan hasil backtest.
- Smart Wallet Exit Watch (P0 B7): butuh feed wallet real-time; interface-nya ada di `wallet-score.js` (`walletExited()`), wiring ke `standalone/monitor.js` belum.
- Dynamic Bins ATR (P0 B4): `computeBinsBelow()` di exit-rules.js sudah berbasis volatilitas; bundle ini hanya mengubah inputnya jadi ATR 1h/24h — lihat catatan di `patches/02-...` bagian bawah.
- RPC failover penuh + Telegram: `health.js` hanya decision; wiring ke `standalone/rpc.js` dan `telegram.js` belum.

## Cara apply (di repo Atomo, di branch baru)
1. `git checkout -b bot-baru-p0-p1`
2. `git apply patches/01-llm-reasoning-effort.patch patches/02-exit-rules-emergency-oor.patch`
3. Salin `modules/*.js` ke repo (lokasi yang disarankan ada di header tiap file).
4. Gabungkan `user-config.p0-p1.json` ke `user-config.json` (manual, cek satu-satu — jangan overwrite).
5. `node --check agent.js config.js exit-rules.js modules/*.js` — semua harus lolos.
6. Jalankan `shadowMode: true` / DRY_RUN dulu. Uji: satu cycle screening, satu cycle management, satu skenario dump (Emergency SL), satu skenario OOR kanan PnL minus (harus HOLD).
7. Baru bicara live — setelah backtest B6 + shadow 30 sesi PF > 1,5.

## Keputusan Atomo yang dikunci di bundle ini
- SOL side, single-sided. SL normal -15%, Emergency SL -10% + dump terkonfirmasi (2 dari 3: harga -5%/15 mnt, bin turun >=8/10 mnt, 3 candle 5m merah + volume >2x).
- Reshape hanya turun, per 5 bin, Spot -> Bid-Ask, maks 3x/posisi, cooldown 30-60 mnt.
- OOR kanan: PnL >= 0 -> close; PnL < 0 -> HOLD (max wait 240 mnt, max jarak 25 bin, breakout terkonfirmasi -> close).
- LLM: DeepSeek V4.1 Flash 1017 via OpenRouter, semua peran, temperature 0,15, maxTokens 8192, reasoning high (Screener) / low (Manager).
- Jupiter referral di-override ke akun Atomo. HiveMind off / pullMode manual. ALLOW_SELF_UPDATE=false.
