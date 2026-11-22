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
| 7 | **Daily loss limit + kill switch** — ekuitas (wallet + posisi, default dalam SOL) dicek tiap siklus manajemen dan tiap 60 dtk dari poller. Rugi harian ≤ `dailyLossLimitPct` (−5%) dari awal hari WIB → stop deploy sampai besok. Drawdown ≤ `portfolioKillSwitchPct` (−10%) dari peak → kill switch. **`killSwitchMode` default `"log"`**: hanya mencatat `KILL SWITCH WOULD TRIP` di log, tidak menutup posisi / pause entry; `"enforce"` = tutup semua + pause `killSwitchPauseHours` (24 jam); `"off"` = mati. Anti salah-baca: equity tidak dihitung `portfolioSettleSec` (120 dtk) setelah transaksi dan saat posisi baru belum muncul di API Meteora (`portfolioIndexGraceMin` 10 mnt); posisi yang sudah ditutup tapi masih tercantum diabaikan; kill switch harus bertahan 3 cek ≥ 3 mnt, daily loss 2 cek. Data ekuitas tidak lengkap → hanya blok deploy, tidak pernah menutup posisi. | `modules/portfolio-runner.js`, `modules/portfolio-guard.js`, `tools/executor.js` (gate deploy) |
| 8 | **Regime gate (mode log-only)** — tiap deploy cek SOL 24 jam ≤ `regimeSol24hDropPct` (−10%) atau BTC 1 jam ≤ `regimeBtc1hDropPct` (−5%) (CoinGecko, cadangan Binance). Mode `log` (default): deploy tetap jalan, tapi dicatat di decision-log + ditandai di posisi; `node cli.js regime` membandingkan hasil deploy "seharusnya diblokir" vs normal. Ganti ke `enforce` hanya bila datanya jelas buruk (20+ sampel). Data market gagal = tidak memblokir. Aturan tren EMA200 mati default (`regimeUseTrendRule`). | `modules/regime-gate.js`, `modules/regime-runner.js` |
| 9 | **Smart Wallet Exit Watch** (standalone) — wallet pemicu entry + posisi DLMM mereka dicatat di posisi kita. Tiap `walletExitCheckSec` (60 dtk) dicek: posisi mereka ditutup (dan tidak pindah ke posisi baru di pool yang sama) atau likuiditas turun ≥ `walletExitShareDropPct` (50%) = keluar. ≥ `walletExitMinWallets` (2) keluar → Rule 6 menutup posisi (`walletExitAction: "log"` = hanya catat). Gagal baca = tidak dihitung. | `modules/wallet-exit-watch.js`, `exit-rules.js` Rule 6 |
| 10 | **Partial TP** (`partialTpEnabled`) — +5% tarik 50% ukuran awal, +10% tarik 25% lagi (fee diklaim, token dijual ke SOL lewat swap guard); sisanya jalan dengan trailing / SL. TP penuh pindah ke `partialTpFinalPct` (+20%). Dikonfirmasi 2 tick seperti exit; gagal = jeda 5 mnt. PnL tetap kontinu (Meteora menghitung withdrawal). | `modules/partial-tp.js`, `modules/partial-tp-runner.js`, tool `partial_close_position` |
| 11 | **Riwayat detektor dump tersimpan** di `dump-history.json` (tiap 30 dtk + saat shutdown); dipulihkan saat start (data > 45 mnt dibuang). Restart tidak lagi membuat bot "buta" dump. | `modules/dump-detector.js` |
| 12 | **RPC failover multi-endpoint** — daftar RPC dari `RPC_URL` + `rpc-endpoints.json` (contoh: `rpc-endpoints.example.json`, dibaca ulang otomatis tanpa restart) + `RPC_URLS` + `FALLBACK_RPC_URL`. Semua request (kirim tx, pool, saldo, PnL, monitor wallet) memakai endpoint aktif. HTTP 429 → endpoint diistirahatkan 60 dtk dan langsung pindah; 3 error 5xx/timeout dalam 30 dtk → istirahat 120 dtk dan pindah; probe getSlot hemat (aktif tiap 15 dtk, cadangan tiap 60 dtk). Kembali ke `RPC_URL` setelah sehat 3x. Semua mati > 60 dtk → **safe mode** (deploy & reshape diblokir, close tetap dicoba). `node cli.js rpc` / `/rpc` untuk status. URL tidak pernah di-log. | `modules/rpc-health.js`, `standalone/rpc.js` |

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
- Fee harvest, sizing, wallet score: modulnya masih fungsi murni yang belum disambungkan ke runtime.
- Smart Wallet Exit Watch hanya untuk mode standalone (mode legacy tidak mencatat wallet pemicu).
- Isi `rpc-endpoints.json` (salin dari `rpc-endpoints.example.json`) dengan RPC dari provider berbeda agar failover berguna.
- WebSocket monitor smart wallet tetap di `MONITOR_WS_URL`/RPC utama; kalau WS mati, entry tetap tertangkap lewat
  rekonsiliasi berkala (`walletReconcileSec`) yang sudah ikut failover — hanya lebih lambat.
- Format respons OHLCV Meteora belum diverifikasi dari container build; parser dibuat defensif.
  Bila fetch gagal, sinyal candle dianggap tidak aktif (dump butuh harga + bin).

## Setup VPS baru (Ubuntu 22.04 / 24.04)

1. **Paket dasar + Node 22 + PM2** (sebagai user biasa dengan sudo, bukan root):

```bash
sudo apt update && sudo apt install -y git curl build-essential
```

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
```

```bash
sudo npm install -g pm2
```

2. **Clone + branch `op-v2`** (repo private: pakai deploy key / token GitHub di VPS):

```bash
git clone https://github.com/woeatomo/Meridian-OP.git ~/Meridian-OP && cd ~/Meridian-OP && git checkout op-v2
```

```bash
npm install
```

3. **Buat semua file config** (`user-config.json`, `rpc-endpoints.json`, `smart-wallets.json`;
   shadow mode ON, tanpa key RPC lama):

```bash
npm run init:op
```

4. **`.env`** — hanya rahasia non-RPC: `WALLET_PRIVATE_KEY`, `OPENROUTER_API_KEY`,
   `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Pakai wallet khusus bot, bukan wallet utama.

```bash
nano .env && chmod 600 .env
```

5. **RPC** — isi `apiKey` di `rpc-endpoints.json`, lalu cek:

```bash
nano rpc-endpoints.json && node cli.js rpc
```

6. **Smart wallet** (standalone butuh minimal 2):

```bash
node cli.js wallets add --address <ALAMAT_WALLET> --name <NAMA>
```

7. **Cek + baseline portfolio guard**:

```bash
npm run test:op && node cli.js balance && node cli.js guard --reset
```

8. **Jalankan (shadow mode)** + auto-start saat VPS reboot:

```bash
npm run pm2:start && pm2 save && pm2 startup
```

```bash
pm2 logs meridian --lines 100
```

9. **Live** — setelah shadow berjalan baik: set `"shadowMode": false` di `user-config.json`, lalu:

```bash
node cli.js guard --reset && npm run pm2:restart
```

Keamanan: bot tidak butuh port masuk — cukup buka SSH (`sudo ufw allow OpenSSH && sudo ufw enable`).
Jangan pernah membagikan `.env`, `rpc-endpoints.json`, atau `user-config.json`.

## Setting RPC + API key (satu tempat: `rpc-endpoints.json`)

Semua RPC **dan API key-nya** diatur di **`rpc-endpoints.json`** saja. `RPC_URL` / `HELIUS_API_KEY`
di `.env` dan `rpcUrl` di `user-config.json` **tidak perlu diisi** — kalau kosong, endpoint pertama
di file dipakai sebagai RPC utama. (Kalau masih diisi, `RPC_URL` tetap jadi prioritas pertama;
sebaiknya hapus supaya tidak ada dua tempat.)

```bash
cp rpc-endpoints.example.json rpc-endpoints.json && chmod 600 rpc-endpoints.json
```

```json
{ "endpoints": [
  { "name": "helius",    "provider": "helius",  "apiKey": "KEY_HELIUS" },
  { "name": "alchemy",   "provider": "alchemy", "apiKey": "KEY_ALCHEMY" },
  { "name": "quicknode", "url": "https://xxx.solana-mainnet.quiknode.pro/{apiKey}/",
                         "ws":  "wss://xxx.solana-mainnet.quiknode.pro/{apiKey}/", "apiKey": "TOKEN" }
] }
```

- `provider` `helius` / `alchemy` + `apiKey` → URL dan websocket dibuat otomatis.
- Provider lain: tulis `url` (dan `ws`) dengan `{apiKey}` di posisi key. Atau `apiKeyParam: "api-key"`
  untuk menempelkan key sebagai query param ke `url` biasa.
- `apiKey` boleh `"env:NAMA"` kalau mau key tetap di `.env` yang dienkripsi.
- Entri tanpa key / URL tidak valid dilewati dan muncul di log (nama saja).
- Urutan = prioritas. File dibaca ulang otomatis saat diubah (tanpa restart).
- API key / URL **tidak pernah** ditulis ke log, Telegram, atau `node cli.js rpc` — hanya `name`.
- Cek: `node cli.js rpc`.

Opsional, hanya kalau perlu RPC terpisah: `MONITOR_RPC_URL` + `MONITOR_WS_URL` (monitor wallet
memakai endpoint ini dan TIDAK ikut failover), `BALANCE_RPC_URL`, `PNL_RPC_URL`.

## Deploy di VPS (instalasi baru)

Butuh Node.js 22+, git, dan PM2 (`npm i -g pm2`).

```bash
git clone -b op-v2 https://github.com/woeatomo/Meridian-OP.git ~/Meridian-OP
```

```bash
cd ~/Meridian-OP && npm install && npm run test:op
```

1. `.env` — salin dulu dari contoh: `cp .env.example .env && chmod 600 .env`, lalu edit.
   Isi minimal `WALLET_PRIVATE_KEY`, `OPENROUTER_API_KEY` (atau `LLM_API_KEY`), opsional
   `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`. **Hapus atau kosongkan** baris `RPC_URL`,
   `HELIUS_API_KEY`, `FALLBACK_RPC_URL`, `MONITOR_RPC_URL`, `BALANCE_RPC_URL`, `PNL_RPC_URL` kalau ada —
   nilai contoh/placeholder di sana akan mengalahkan `rpc-endpoints.json`.
2. `cp rpc-endpoints.example.json rpc-endpoints.json && chmod 600 rpc-endpoints.json`, isi `apiKey`.
3. `npm run init:config` — membuat `user-config.json` (template + Meridian-OP, shadowMode on, tanpa key RPC).
   Biarkan `walletAddress` **kosong** — alamat diambil dari `WALLET_PRIVATE_KEY`. Kalau diisi, harus
   alamat wallet bot yang sama; kalau beda, bot menolak start di mode live (peringatan saja di shadow).
4. Smart wallet yang dipantau (minimal `walletThreshold`, default 2):
   `node cli.js wallets add --address <ALAMAT> --name <NAMA>`
5. Cek: `node cli.js rpc`, `node cli.js wallets`, `node cli.js guard`.
6. Jalankan shadow dulu: `npm run pm2:start`, pantau `npm run pm2:logs`.
7. Live: ubah `shadowMode` ke `false` di `user-config.json`, `npm run pm2:restart`, lalu
   `node cli.js guard --reset`.

Update berikutnya: `git pull origin op-v2 && npm install && npm run init:config && npm run pm2:restart`
(`init:config` hanya menambah key baru, setelanmu tidak ditimpa).

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
