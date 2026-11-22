# Meridian-OP — branch `op-v2`

Branch ini yang dipakai di VPS. Isinya: bundle P0+P1 di bawah **plus** perbaikan manajemen
posisi saat dump dan reshape yang benar-benar berjalan (sebelumnya modulnya ada tapi tidak
pernah dipanggil).

## Yang berubah di `op-v2`

| # | Perbaikan | File utama |
|---|---|---|
| 1 | **Detektor dump** — 2 dari 3 sinyal (harga −5%/15 mnt, bin turun ≥8/10 mnt, 3 candle 5m merah + volume >2x). Mengisi `dump_confirmed` di tiap posisi, jadi **Emergency SL −10% sekarang aktif** (dulu field ini tidak pernah diisi → bot baru keluar di −15%). | `modules/dump-detector.js`, `modules/position-annotate.js`, `tools/dlmm.js#getMyPositions` |
| 2 | **OOR sadar arah** — OOR kiri (harga di bawah range, posisi penuh token) tetap ditutup setelah `outOfRangeWaitMinutes`. OOR kanan (posisi penuh SOL) tidak lagi ikut tertutup 30 mnt; diserahkan ke Rule 3/4 (close bila PnL ≥ 0, HOLD bila minus sampai 240 mnt / 25 bin). | `state.js#updatePnlAndCheckExits` |
| 3 | **Swap guard** — swap token→SOL setelah close dicek price impact (`maxSwapPriceImpactPct`, default 3%) sebelum tanda tangan; bila terlalu besar dipecah bertahap (sampai `swapMaxChunks`). Sisa yang tetap terblokir dicatat dan dicoba lagi tiap siklus manajemen. Slippage zap-out relay turun dari 50% ke `relayCloseSlippageBps` (10%). | `tools/wallet.js`, `tools/executor.js`, `state.js` (pendingSwaps) |
| 4 | **Reshape** — keputusan + eksekusi + PnL berantai. Lihat bagian Reshape. | `modules/reshape-manager.js`, `modules/reshape-runner.js`, `tools/dlmm.js#reshapePosition` |
| 5 | **Cooldown token** — 2x Emergency SL dalam 24 jam pada token yang sama → token + pool cooldown 24 jam. | `pool-memory.js` |
| 6 | Alert Telegram untuk Emergency SL dan reshape. CLI `withdraw-liquidity` / `add-liquidity` yang dulu rusak (fungsi tidak di-export) sekarang jalan; tambah CLI `reshape`. | `telegram.js`, `cli.js` |
| 7 | **Daily loss limit + kill switch** — ekuitas (wallet + posisi, default dalam SOL) dicek tiap siklus manajemen dan tiap 60 dtk dari poller. Rugi harian ≤ `dailyLossLimitPct` (−5%) dari awal hari WIB → stop deploy sampai besok. Drawdown ≤ `portfolioKillSwitchPct` (−10%) dari peak → tutup semua posisi + pause entry `killSwitchPauseHours` (24 jam). Data ekuitas tidak lengkap → hanya blok deploy, tidak pernah menutup posisi. | `modules/portfolio-runner.js`, `modules/portfolio-guard.js`, `tools/executor.js` (gate deploy) |
| 8 | **Regime gate (mode log-only)** — tiap deploy cek SOL 24 jam ≤ `regimeSol24hDropPct` (−10%) atau BTC 1 jam ≤ `regimeBtc1hDropPct` (−5%) (CoinGecko, cadangan Binance). Mode `log` (default): deploy tetap jalan, tapi dicatat di decision-log + ditandai di posisi; `node cli.js regime` membandingkan hasil deploy "seharusnya diblokir" vs normal. Ganti ke `enforce` hanya bila datanya jelas buruk (20+ sampel). Data market gagal = tidak memblokir. Aturan tren EMA200 mati default (`regimeUseTrendRule`). | `modules/regime-gate.js`, `modules/regime-runner.js` |

### Reshape (Spot → Bid-Ask, satu arah ke bawah)

Dievaluasi di poller cepat (tiap `pnlPollIntervalSec`) hanya bila **tidak ada sinyal exit**.
Syarat RESHAPE (semua harus terpenuhi):
- `reshapeEnabled: true`, posisi masih in range, PnL bisa dihitung;
- harga turun ≥ `reshapeBins` (5) bin dari anchor (bin saat deploy / reshape terakhir);
- **turun pelan**: < `dumpBinDrop` (8) bin per 10 mnt dan dump tidak terkonfirmasi — kalau dump, exit rules yang memutuskan;
- **bukan rebound**: active bin ≤ low 10 menit + `reshapeReboundToleranceBins`;
- PnL > `reshapeMinPnlPct` (−12%) — terlalu dekat SL, biarkan SL;
- cooldown `reshapeCooldownMinutes` (45) lewat, belum `reshapeMaxPerPosition` (3) kali;
- fee posisi ≥ `reshapeFeeCostMultiple` × `reshapeCostUsd`;
- kondisi di atas bertahan `reshapeConfirmMinutes` (2) berturut-turut (hysteresis).

Eksekusi (`reshape_position`, lewat wallet lock + safety check ulang):
1. Rencanakan range baru dan pastikan bin array sudah ada **sebelum** menyentuh dana.
2. Tarik semua likuiditas + klaim fee + tutup posisi, **tanpa swap**; ukur selisih saldo token & SOL.
3. Buka posisi baru (`reshapeStrategy`, default bid_ask): **token di atas harga** sampai bin atas awal
   (dijual lebih banyak saat rebound ke harga lebih tinggi), **SOL di bawah harga** (DCA ke bawah).
4. PnL posisi baru dirantai: `pnl_pct = faktor_lineage × (1 + pnl_baru) − 1`, sehingga SL −15% /
   Emergency SL / trailing tetap dihitung dari modal awal. Peak trailing ikut terbawa.
5. Bila buka posisi baru gagal setelah penarikan: posisi lama dicatat closed, token dijual ke SOL
   (dengan swap guard), dan alert Telegram dikirim.

Lessons / pool-memory mencatat satu trade per lineage (modal awal + total durasi), bukan per re-deposit.

### Belum dikerjakan (sengaja)
- **Reshape parsial dulu** (spec: "partial dulu") — butuh dua posisi per pool sementara, sedangkan
  safety check masih 1 posisi/pool. Ditunda sampai ada data shadow.
- Partial TP, fee harvest, sizing, wallet score, health: modulnya masih fungsi murni
  yang belum disambungkan ke runtime.
- Format respons OHLCV Meteora belum diverifikasi dari container build; parser dibuat defensif.
  Bila fetch gagal, sinyal candle dianggap tidak aktif (dump butuh harga + bin).

## Deploy di VPS

```bash
cd ~/Meridian-OP
git fetch origin op-v2
git checkout op-v2
git pull origin op-v2
npm install
npm run test:op
```

Gabungkan key baru dari `user-config.p0-p1.json` ke `user-config.json` secara manual
(`reshapeEnabled`, `dump*`, `reshape*`, `swapMaxChunks`, `relayCloseSlippageBps`, …).
Jalankan dulu dalam shadow / DRY_RUN (`shadowMode: true` atau `npm run dev`), cek log
`[DUMP_WARN]`, `[RESHAPE]`, `[EXECUTOR_WARN]`, lalu restart PM2:

```bash
npm run pm2:restart
```

Portfolio guard: status dan reset baseline. **Setelah deposit / withdraw manual ke wallet bot,
selalu reset** — kalau tidak, transfer itu terbaca sebagai profit / rugi:

```bash
node cli.js guard
```

```bash
node cli.js guard --reset
```

(`--reset --clear-kill` juga mencabut kill switch yang sedang aktif. Mode legacy punya `/guard`,
`/guard reset`, `/guard reset kill` di Telegram.)

Uji manual satu posisi (respek `reshapeEnabled`; di DRY_RUN hanya menampilkan rencana):

```bash
node cli.js reshape --position <alamat_posisi>
```

---

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
