# Zenith — Extension Chrome (Gemini-only, Tanpa Backend, Tanpa Bot Join)

Baca soal dari tab gamemu sendiri → selesaikan pakai Gemini → tampilkan + highlight.
Tidak ada server sendiri, tidak ada bot yang join ke game. Key Gemini milikmu, tersimpan di `chrome.storage.local`.

Versi: `2.3.1` (lihat `manifest.json`).

## Cara install (Developer Mode, Desktop)
1. Buka `chrome://extensions`
2. Nyalakan **Developer mode** (kanan atas)
3. **Load unpacked** → pilih folder `extension/` ini
4. Pin ikon extension biar gampang buka popup

## Setup sekali (wajib)
1. Buat key gratis: https://aistudio.google.com/api-keys
2. Klik ikon extension → tempel key → **Simpan Key** → **Tes Key** (harus ✅)

## Cara pakai
**Live / PIN (tanpa bot):**
1. Join game Wayground/Quizizz/Kahoot seperti biasa di tab
2. Extension otomatis baca soal dari trafikmu sendiri → batch ke Gemini 1x → panel muncul
3. Pindah soal berikutnya **instan** (cache lokal per soal `dh_q_*`, tidak manggil AI lagi)
4. Panel bisa minimize (—), hide (✕), toggle cepat `Alt+H`
5. Pas panel di-hide, yang tersisa cuma **titik abu-abu 12px** di kiri bawah (hover membesar). Highlight jawaban **tetap jalan** walau panel hidden.

**Link / ID quiz publik:**
- Tempel link/ID di popup → **Ambil + Selesaikan** (GET publik ke `wayground.com/api/main/quiz/...`, bukan join; kalau respons bawa kunci publik langsung dipakai, hemat AI)

## Kahoot live (v2.4.0+)
- Join PIN seperti biasa → extension sadap cometd WS (`reserve/session` = status PIN, `type=quiz` = soal full, id 1/2 = GetReady/QuestionStart).
- **Syarat mutlak:** host wajib nyalain **"Show questions on players' devices"**. Mode shapes-only (HP cuma tombol warna) = tidak ada teks yang dikirim = tidak bisa dijawab tool apa pun.
- Tanpa kunci publik (server Kahoot tidak pernah kirim jawaban) → **murni AI per soal** (±2–5 dtk, tergantung timer). Tanpa auto-click (stealth highlight-only).
- Fallback: baca DOM HP (`data-functional-selector`) + tempel ID/challenge manual di popup (quiz publik saja).

**Kalau panel belum jawab:** klik **Selesaikan soal di tab aktif**.

## Stealth
- Tema panel **dark redup** (bukan biru/putih menyala), opacity ~0.97
- FAB = titik abu-abu kecil, bukan emoji 📝
- `Alt+H` (atau `Ctrl+Shift+H`) toggle panel tanpa klik tombol
- Judul netral: **Zenith**. Tidak ada tulisan "hack/cheat" di UI

## Akurasi
- Highlight ≈ 95% benar menurut laporan user, tapi **AI bisa salah** — selalu ada label **AI ✨**. Cross-check soal jebakan (kata "kecuali/bukan", isian angka).

## Android (eksperimental, belum dites)
- Chrome bawaan Android **tidak support extension**. Pakai **Lemur Browser / Mises Browser** → import folder ini sebagai .zip → join via browser itu.
- Risiko: injeksi MAIN world (`chrome.scripting`, `hook.js`) kadang dibatasi browser HP → soal live bisa gagal ketangkep, fallback baca-layar + quiz publik tetap jalan.

## File
- `manifest.json` — MV3 (host: wayground, quizizz, kahoot, googleapis saja)
- `background.js` — GET publik + call Gemini (batch 8 soal, timeout 90 dtk, auto-discovery `ListModels` + fallback `GEMINI_MODELS`)
- `hook.js` — jalan di MAIN world via `chrome.scripting`, sniff XHR/fetch (`join`, `rejoin`, `quiz-info`, `attempts`, `api/main/quiz`, `soloJoin`) + websocket
- `content.js` — terima pesan hook, normalisasi soal, batch + cache per soal, overlay + highlight
- `content.css` — tema stealth dark + titik FAB
- `popup.html` / `popup.js` — simpan/tes key, trigger solve
- `icons/` — ikon extension
- `SESSION_HANDOFF.md` — state sesi buat lanjut kalau chat mati

## Troubleshooting
- `401 .../_api/main/user` → normal (main sebagai guest, abaikan)
- `ERR_BLOCKED_BY_CLIENT (hotjar/survicate)` → adblock ngeblok tracker, abaikan
- `net:room ... hasQuestions:true` → hook berhasil nangkep soal live (bagus)
- `net:quizInfo` cuma metadata (judul/mapel) → normal di lobby, soal turun pas game mulai
- Tombol minimize/hide gagal → pastikan versi `2.3.1`, lalu **reload extension (↻) + hard reload tab (`Ctrl+Shift+R`)**. Panel baru ditandai `data-fixed="v3"`: cek via `document.getElementById('dh-lite-frame')?.dataset.fixed` harus `"v3"`. Tes klik via console: `document.getElementById('dh-lite-min').click()`.
- Highlight mati pas panel hidden → sudah di-fix (v2.3.x): highlight hanya peduli checkbox "Highlight jawaban", bukan panel kebuka.
