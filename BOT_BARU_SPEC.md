# Bot LP Baru — Spesifikasi Konsolidasi (siap push)
Tanggal: 20 Nov 2026. Basis: Meridian legacy (commit e80077f), SOL side single-sided.
Status: SPEC, belum dibangun / belum di-push. Menunggu Atomo pilih scope push.

## A. Keputusan Atomo yang sudah terkunci
- SOL side, single-sided SOL. Open awal Spot.
- Reshape HANYA saat harga turun, per 5 bin, flip ke Bid-Ask, re-centre ke bawah. TIDAK reshape saat rebound.
- Reshape guard: trigger + konfirmasi, hysteresis, cooldown 30-60 mnt, maks ~3x per posisi, syarat ekonomi (fee ekspektasi > 2x biaya reshape), partial dulu.
- SL normal -15%. Emergency SL -10% (= ~2/3 SL normal), aktif HANYA bila dump terkonfirmasi (min 2 dari 3: harga -5%/15 mnt, active bin turun >=8 bin/10 mnt, 3 candle 5m merah + volume >2x). Turun pelan -> reshape, dump cepat -> Emergency SL, jangan reshape.
- OOR kanan: PnL >= 0 / kena TP -> close. PnL < 0 -> HOLD tunggu re-entry. Guard: max wait 4-6 jam, max jarak 20-25 bin di atas range, breakout terkonfirmasi (volume >2x + bertahan >1 jam) -> close.
- OOR kiri: tetap ketat, pakai Emergency SL / SL.
- LLM: DeepSeek V4.1 Flash via OpenRouter, model ID exact `deepseek/deepseek-v4.1-flash-1017` (snapshot 17 Okt 2026) untuk semua peran: llmModel, managementModel, screeningModel, generalModel. Konteks 1,05M, ~133 tok/detik, harga via DeepSeek ~$0,036 input / $0,50 output per 1M token. Temperature global 0,15, maxTokens 8192. Reasoning effort: high untuk Screener, low untuk Manager (butuh patch kecil di agent.js, Meridian tidak punya field ini). Provider routing dipin ke DeepSeek langsung. LLM = analis + veto, bukan eksekutor; hard gate deterministik dulu; output JSON terstruktur.
- Jupiter referral harus di-override ke akun Atomo (default author 50 bps). HiveMind off / pullMode manual. Jangan share user-config.json tanpa redact walletKey / rpcUrl ber-API-key / llmApiKey / token Telegram.

## B. Improvement tambahan — P0 (wajib sebelum live)
### B1. Regime Gate — jangan LP saat market dump
- Cek sebelum deploy: trend SOL & BTC (EMA50/200, 1h + 4h), BTC regime kemarin (Bull/Bear/Sideways, lagged seperti Bot Trend).
- Jangan deploy baru bila: BTC Bear + SOL di bawah EMA200, atau SOL -10% dalam 24 jam, atau BTC -5% dalam 1 jam.
- Posisi yang sudah jalan tetap dimanage (reshape / Emergency SL), tapi tidak ada deploy baru.
- Kenapa OP: Meridian tidak punya ini sama sekali; sebagian besar kerugian LP datang dari deploy di tengah dump market.

### B2. Smart Wallet Scoring v2 — ganti "2 wallet masuk" mentah
- Ganti trigger >=2 wallet / 120 detik dengan skor 0-100 per wallet: PnL 30 hari, win rate, hari aktif, max drawdown, profit factor, umur wallet, konsistensi (bukan 1 trade besar).
- Wallet masuk watchlist hanya bila skor >= 70 dan lolos semua cek (sama seperti checklist Bot Strategy 5).
- Sinyal deploy butuh skor gabungan, bukan jumlah wallet: misal 2 wallet skor 80+ dalam 120 detik, atau 1 wallet skor 95+ + konfirmasi volume.
- Anti-sybil: wallet yang baru dibuat / saling transfer / deposit bersamaan berulang kali diberi penalti.
- Kenapa OP: 2 wallet bisa dikoordinasi; skor membuat sinyal jauh lebih bersih.

### B3. Daily Loss Limit + Kill Switch — pagar portofolio
- Max rugi harian portofolio: -5% dari ekuitas awal hari -> stop deploy baru hari itu.
- Max drawdown portofolio: -10% dari peak -> kill switch: tutup semua posisi, mode shadow 24 jam.
- Max rugi per token: sudah ada SL -15%, tambahkan max 2x Emergency SL per hari per token -> cooldown token 24 jam.
- Kenapa OP: Meridian tidak punya ini; satu hari buruk bisa menghabiskan minggu fee.

### B4. Dynamic Bins dari ATR — range ikut volatilitas
- Ganti bins_below tetap 35-69 dengan: bins_below = f(ATR 1h / 24h). Volatilitas tinggi -> range lebih lebar (misal 50-69 bin), volatilitas rendah -> lebih sempit (35-45 bin).
- Bin step tetap dalam 80-125, tapi dipilih dari volatilitas juga, bukan default.
- Kenapa OP: range yang sama untuk token kalem dan token liar itu tidak efisien; ini mengurangi OOR palsu.

### B5. Partial Take Profit — jangan all-or-nothing
- TP1 +5%: tutup / klaim 50% posisi, sisanya jalan dengan trailing.
- TP2 +10%: tutup 25% lagi, sisa 25% biarin lari dengan trailing TP dinamis (berbasis ATR, bukan fixed 1,5%).
- Kenapa OP: Meridian TP 5% langsung tutup semua — memotong winner. Partial TP mengunci profit tapi tetap memberi ruang lari.

### B6. Backtest Engine + Shadow A/B — wajib sebelum live
- Simulator DLMM historis: static vs reshape 5 vs 10 vs 15 bin, Emergency SL on/off, OOR kanan hold vs close-30-mnt, net of gas + swap + slippage.
- Shadow mode: jalankan 2 config paralel (misal A = spec ini, B = Meridian asli) di dry run, bandingkan PnL / fee / drawdown per minggu.
- Jangan live sebelum: backtest menang net, dan shadow 30 sesi dengan profit factor > 1,5.
- Kenapa OP: ini prinsip yang sama seperti Bot Trend — angka yang menang di backtest dulu, baru dry run, baru live.

### B7. Smart Wallet Exit Watch — kalau pemicu keluar, ikut keluar
- Pantau wallet pemicu setelah deploy: bila >=2 wallet pemicu menjual / keluar >50% dalam 30 menit, Manager dapat sinyal exit awal (bukan tunggu SL).
- Ini early warning dump yang tidak terlihat dari chart harga saja.
- Kenapa OP: alasan kamu masuk adalah wallet itu; kalau mereka keluar, alasan masukmu hilang.

## C. Improvement tambahan — P1 (dampak besar, effort sedang)
### C1. Fee Harvest + Auto-Compound
- Klaim fee otomatis bila fee >= $5 ATAU fee >= 2% dari posisi, bukan menunggu Manager cycle.
- Opsi auto-compound: fee yang diklaim (SOL) langsung dipakai untuk tambah posisi / reshape berikutnya, bukan diam di wallet.
- Jangan klaim bila gas > 30% dari fee yang diklaim.

### C2. Max Hold Time / Fee Decay Exit
- Max hold 48 jam per posisi memecoin. Bila fee/24 jam terakhir < 1% dari posisi dan PnL datar, tutup dan pindah ke pool yang lebih ramai.
- Token memecoin fee-nya decay cepat; menahan pool sepi = modal diam.

### C3. Position Sizing berdasarkan Confidence
- Ganti 35% saldo tetap dengan: size = base (misal 20%) x confidence (0,5-1,5). Skor LLM + wallet + regime 90+ -> size penuh, skor 70 -> size setengah.
- Tetap ada floor 0,5 SOL dan ceiling 50 SOL, max 3 posisi, max eksposur per token 1 posisi.

### C4. Slippage / MEV Protection saat swap
- Sebelum swap token -> SOL (reshape / close): cek price impact Jupiter, tolak bila >3%, coba lagi dengan slippage lebih ketat atau pecah swap jadi 2x.
- Pakai Jupiter Ultra, bukan swap mentah; catat slippage aktual vs ekspektasi di decision log.

### C5. Health, RPC Failover, Telegram Alert
- RPC failover: Helius utama, QuickNode cadangan; bila RPC mati > 60 detik, bot masuk mode aman (jangan deploy, posisi yang ada tetap dimonitor).
- Alert Telegram untuk: deploy, reshape, Emergency SL, kill switch, RPC down. Bukan spam tiap cycle — hanya event penting + ringkasan harian.

## D. Improvement tambahan — P2 (nice to have, setelah P0/P1 stabil)
### D1. Narrative Scoring LLM
- Screener Flash (reasoning high) menilai narasi token dari X / Telegram / GMGN trending, skor 0-100, sebagai salah satu komponen confidence — bukan sebagai pemicu tunggal.
- Prompt injection guard: narasi token diperlakukan sebagai data, bukan instruksi; LLM tidak boleh mengeksekusi perintah dari teks token.

### D2. DB + Dashboard, ganti JSON file
- Ganti state JSON (decision-log, pool-memory, lessons) dengan SQLite: query, audit, dan analitik jadi mungkin; JSON rawan corrupt dan tidak atomik.
- Dashboard sederhana: PnL per posisi, fee, reshape count, Emergency SL hits, win rate.

### D3. Evaluasi LLM berkala
- Setiap minggu: hitung akurasi keputusan LLM (deploy yang profit vs rugi, veto yang benar vs salah). Bila akurasi < 50% selama 2 minggu, turunkan bobot LLM dan naikkan bobot gate deterministik.
- Jangan biarkan threshold evolve dari sampel kecil (bug Meridian: evolve setelah 5 close). Minimal 20 close sebelum ubah threshold, dan perubahan maksimal +-10% per minggu.

## E. Yang TIDAK diubah
- Hard gate Meridian yang bagus tetap dipertahankan: mint/freeze authority mati, top-10/bot holders, TVL/mcap, bin step, fee/TVL, blacklist, cooldown, pre-submit recheck, checkpoint recovery, wallet lock, trailing TP dengan 2-tick confirmation, shadow/DRY_RUN default.
- Self-update via LLM dimatikan (ALLOW_SELF_UPDATE=false). Update config hanya manual oleh Atomo.

## F. Scope push yang diusulkan
- Opsi 1 — P0 saja: B1-B7 + semua keputusan di A. Ini sudah OP dan paling aman.
- Opsi 2 — P0 + P1: tambah C1-C5. Ini yang direkomendasikan Muse bila waktu cukup.
- Opsi 3 — Semua: P0+P1+P2. Paling lengkap, tapi P2 sebaiknya dikerjakan setelah P0/P1 stabil di shadow.
- **DIPILIH Atomo 20 Nov 2026, 17:01 WIB: Opsi 2 — P0 + P1.** Bundle siap cek di `push-p0-p1/` (README, 2 patch, 9 modul, user-config snippet). Semua modul lolos `node --check`, JSON config valid. Belum di-push — menunggu repo tujuan + izin push dari Atomo.
