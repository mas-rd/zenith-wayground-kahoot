/* DitHack Lite — content script (GEMINI ONLY, NO BOT JOIN)
 * - Baca soal dari trafik game MILIKMU sendiri (XHR/fetch + websocket, lobby -> main)
 * - Kunci publik (kalau ada) dipakai langsung; sisanya batch ke Gemini + cache per soal
 */
(() => {
  "use strict";
  if (window.__dithackLiteLoaded) return;
  window.__dithackLiteLoaded = true;

  /* ============ 1. Hook MAIN world via background (chrome.scripting, kebal CSP).
     Inject <script> inline DIBLOKIR CSP Wayground, jadi hook.js disuntik resmi. */
  function requestHook() {
    try {
      chrome.runtime.sendMessage({ type: "INJECT_HOOK" }, () => void chrome.runtime.lastError);
    } catch {}
  }

  // Diagnostik: ringkas bentuk payload (sekali per bentuk unik biar nggak spam)
  const seenShapes = new Set();
  const netEvents = [];
  function logShape(kind, obj) {
    try {
      const keys = obj && typeof obj === "object" ? Object.keys(obj).slice(0, 14).join(",") : typeof obj;
      const sig = kind + ":" + keys;
      netEvents.push(kind);
      if (netEvents.length > 8) netEvents.shift();
      dbg(netEvents.join(" → "));
      if (seenShapes.has(sig)) return;
      seenShapes.add(sig);
      let sample = "";
      try { sample = JSON.stringify(obj).slice(0, 700); } catch {}
      console.log(`[Zenith] net:${kind} keys=[${keys}] sample=${sample}`);
    } catch {}
  }

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d.__dhLite !== true) return;
    try {
      if (d.kind === "room" && d.payload?.room) {
        const r = d.payload.room;
        logShape("room", { keys: Object.keys(r || {}), hasQuestions: !!(r.questions && Object.keys(r.questions).length), quizId: r.quizId || r.quizID || null, hash: r.hash || null, name: r.name || null });
        handleRoom(r, d.payload.source || "join");
      }
      else if (d.kind === "rejoinRaw" && d.payload?.raw) {
        logShape("rejoinRaw", d.payload.raw?.data || d.payload.raw);
        handleRejoinRaw(d.payload.raw);
      }
      else if (d.kind === "quizInfoRaw" && d.payload?.raw) {
        logShape("quizInfo", d.payload.raw?.data || d.payload.raw);
        const items = extractQuizInfo(d.payload.raw);
        // Di lobby respons quiz-info sering cuma metadata (belum ada soal) — itu normal,
        // soal datang pas game mulai via websocket. Jadi gagal parse = diam saja.
        if (items?.length) mergeItems(items, "quiz-info");
      }
      else if (d.kind === "wsQuestions" && Array.isArray(d.payload?.questions)) {
        logShape("ws", { n: d.payload.questions.length, first: d.payload.questions[0] });
        const items = d.payload.questions.map(normalizeLoose).filter(Boolean);
        if (items.length) mergeItems(items, "live");
      }
      else if (d.kind === "quizId" && d.payload?.quizId) fetchPublicQuiz(d.payload.quizId, d.payload.source || "net");
      else if (d.kind === "soloQuizId" && d.payload?.quizId) fetchPublicQuiz(d.payload.quizId, "solo");
      else if (d.kind === "quizQuestions" && d.payload?.questions?.length) {
        handleRawWayground(d.payload.questions, d.payload.quizId, "quiz-api");
      }
      else if (d.kind === "kahootPin" && d.payload?.pin) {
        state.roomName = "Kahoot PIN " + d.payload.pin;
        setStatus(`Kahoot PIN ${d.payload.pin} ketangkep • nunggu soal (butuh mode tampil-soal-di-HP)…`, "");
        dbg("net: pin " + d.payload.pin);
      }
      else if (d.kind === "kahootIndex" && d.payload?.questionIndex != null) {
        const n = d.payload.questionIndex + 1;
        dbg("net: kahoot soal #" + n);
        setStatus(`Kahoot soal #${n} mulai…`, "");
        const scraped = scrapeKahootVisible();
        if (scraped) handleKahootLive({ ...scraped, questionIndex: d.payload.questionIndex });
      }
      else if (d.kind === "kahootQuestion" && d.payload) {
        logShape("kahootQ", d.payload);
        handleKahootLive(d.payload);
      }
    } catch {}
  });

  try {
    Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
    Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
  } catch {}

  /* ============ 2. State ============ */
  const state = {
    items: [],   // [{question, questionMedia, answers:[{text, mediaUrl}], options:[str], type, tag, ai, pending, qhash}]
    cacheId: null,
    quizId: null,
    roomName: "",
    highlight: true,
    minimized: false,
    userHidden: false,
    solving: false,
  };

  /* ============ 3. Helpers ============ */
  // Wayground soal custom/math: <katex latex="8-3"></katex> — angka di ATRIBUT, bukan teks.
  // Tanpa ini stripHtml menghasilkan "What is ?" (buntung) → AI ngasal / "Soal tidak lengkap".
  const katexToText = (root) => {
    try {
      root.querySelectorAll("katex").forEach((n) => {
        n.replaceWith(document.createTextNode(n.getAttribute("latex") || ""));
      });
      // Fallback MathJax-style: isi script math dipertahankan sebagai teks
      root.querySelectorAll('script[type="math/tex"], script[type="math/asciimath"]').forEach((n) => {
        n.replaceWith(document.createTextNode(n.textContent || ""));
      });
    } catch {}
  };
  const stripHtml = (html) => {
    if (!html) return "";
    const d = document.createElement("div");
    d.innerHTML = String(html);
    katexToText(d);
    d.querySelectorAll("script, style, blank").forEach((n) => n.remove());
    return (d.textContent || "").replace(/\s+/g, " ").trim();
  };
  const cleanHtml = (html) => {
    if (!html) return "";
    const d = document.createElement("div");
    d.innerHTML = String(html);
    try {
      d.querySelectorAll("katex").forEach((n) => {
        const s = document.createElement("code");
        s.textContent = n.getAttribute("latex") || "";
        n.replaceWith(s);
      });
      d.querySelectorAll('script[type="math/tex"], script[type="math/asciimath"]').forEach((n) => {
        n.replaceWith(document.createTextNode(n.textContent || ""));
      });
      d.querySelectorAll("blank").forEach((n) => {
        n.replaceWith(document.createTextNode("___"));
      });
    } catch {}
    return d.innerHTML;
  };
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const bg = (msg) =>
    new Promise((resolve) =>
      chrome.runtime.sendMessage(msg, (r) => {
        const err = chrome.runtime.lastError;
        if (err) resolve({ ok: false, error: "bg: " + err.message });
        else resolve(r || { ok: false, error: "bg: respon kosong" });
      })
    );
  const storeGet = (keys) =>
    new Promise((res) => chrome.storage.local.get(keys, (v) => res(v || {})));
  const storeSet = (obj) =>
    new Promise((res) => chrome.storage.local.set(obj, () => res()));
  const hashStr = (s) => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  };
  const normQ = (t) => stripHtml(t).toLowerCase().replace(/\s+/g, " ").slice(0, 140);
  const optText = (o) => stripHtml(typeof o === "string" ? o : (o?.text || o?.answer || ""));

  /* ============ 4. Normalisasi ============ */
  function fromWaygroundQuestions(arr) {
    if (!Array.isArray(arr)) return null;
    return arr
      .map((q) => {
        const st = q.structure || {};
        const query = st.query || {};
        const qText = query.text || q.question || "";
        const qMedia = query.media?.[0]?.url || query.image || st.image || null;
        const opts = st.options || q.options || q.answers || [];
        const options = opts.map(optText).filter(Boolean);
        const ans = st.answer ?? q.answer;
        let answers = [];
        if ((q.type === "BLANK" || st.kind === "BLANK") && ans !== undefined) {
          const idx = Array.isArray(ans) ? ans : [ans];
          answers = idx.map((i) => (typeof i === "number" && opts[i] ? { text: opts[i].text || "", mediaUrl: opts[i].media?.[0]?.url || null } : { text: String(i), mediaUrl: null }));
        } else if (ans !== undefined) {
          const idx = Array.isArray(ans) ? ans : [ans];
          answers = idx
            .map((i) => {
              if (typeof i === "number") {
                const o = opts[i];
                return o ? { text: o.text || "", mediaUrl: o.media?.[0]?.url || o.image || null } : null;
              }
              return { text: String(i), mediaUrl: null };
            })
            .filter(Boolean);
        }
        return {
          question: qText, questionMedia: qMedia, answers, options,
          type: q.type || st.kind || "MCQ",
          tag: q.type === "BLANK" || st.kind === "BLANK" ? "ISIAN" : "MCQ",
          ai: false, pending: !answers.length,
        };
      })
      .filter((x) => stripHtml(x.question) || x.options.length);
  }

  function fromRoomObject(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    return fromWaygroundQuestions(Object.values(obj));
  }

  function fromKahoot(arr) {
    if (!Array.isArray(arr)) return null;
    return arr.map((q) => {
      const choices = (q.choices || []).map((c) => c.answer || "");
      const correct = (q.choices || []).filter((c) => c.correct);
      return {
        question: q.question || "",
        questionMedia: q.image || q.video?.fullUrl || null,
        answers: correct.map((c) => ({ text: c.answer || "", mediaUrl: c.image || null })),
        options: choices,
        type: q.type || "quiz",
        tag: "KAHOOT",
        ai: false, pending: !correct.length,
      };
    }).filter((x) => stripHtml(x.question) || x.options.length);
  }

  /** Bentuk longgar (websocket / quiz-info tak dikenal): {question, options|choices} atau {structure.query} */
  function normalizeLoose(q) {
    if (!q || typeof q !== "object") return null;
    if (q.structure?.query) return fromWaygroundQuestions([q])?.[0] || null;
    const qText = typeof q.question === "string" ? q.question : (q.text || q.title || "");
    const rawOpts = q.options || q.choices || [];
    const options = (Array.isArray(rawOpts) ? rawOpts : []).map(optText).filter(Boolean);
    if (!stripHtml(qText) && !options.length) return null;
    return {
      question: qText,
      questionMedia: q.image || q.media || null,
      answers: [], options,
      type: q.type || "MCQ", tag: "MCQ",
      ai: false, pending: true,
    };
  }

  /** quiz-info / rejoin mentah: coba banyak bentuk */
  function extractQuizInfo(raw) {
    const cands = [
      raw?.data?.questions,
      raw?.data?.quiz?.questions,
      raw?.data?.quiz?.info?.questions,
      raw?.questions,
      raw?.data?.items,
      raw?.data?.quiz,
      raw?.data,
    ];
    for (const c of cands) {
      if (!c) continue;
      if (Array.isArray(c)) {
        const a = fromWaygroundQuestions(c);
        if (a?.length) return a;
        const k = fromKahoot(c);
        if (k?.length) return k;
      } else if (typeof c === "object" && !c.structure) {
        const vals = Object.values(c);
        if (vals.length && vals.every((v) => v && typeof v === "object" && (v.structure || v.question))) {
          const a = fromRoomObject(c);
          if (a?.length) return a;
        }
      }
    }
    const one = normalizeLoose(raw?.data || raw);
    return one ? [one] : null;
  }

  const itemsHaveAnswers = (items) => items?.some((x) => x.answers?.length);

  function setItems(items, meta = {}) {
    if (!items?.length) {
      setStatus(meta.emptyMsg || "Belum ada data soal.", "warn");
      return;
    }
    state.items = items;
    if (meta.quizId) state.quizId = meta.quizId;
    if (meta.roomName) state.roomName = meta.roomName;
    render();
    setStatus(`${items.length} soal dimuat${meta.source ? " • " + meta.source : ""}`, "ok");
    if (state.highlight) highlightInPage();
  }

  /** Gabung soal baru (dedup), isi kunci yg kosong, auto-solve sisanya */
  function mergeItems(items, source) {
    if (!items?.length) return;
    const seen = new Map(state.items.map((it) => [normQ(it.question) || ("#opts:" + (it.options || []).join("|").slice(0, 80)), it]));
    let added = 0;
    for (const it of items) {
      const k = normQ(it.question) || ("#opts:" + (it.options || []).join("|").slice(0, 80));
      const ex = seen.get(k);
      if (!ex) {
        state.items.push(it);
        seen.set(k, it);
        added++;
      } else if (!ex.answers?.length && it.answers?.length) {
        ex.answers = it.answers;
        ex.pending = false;
      }
    }
    render();
    if (itemsHaveAnswers(state.items) && !state.items.some((x) => !x.answers?.length)) {
      setStatus(`${state.items.length} soal • kunci publik ✅ • ${source}`, "ok");
    } else {
      setStatus(`${state.items.length} soal ketangkep • ${source} • menyelesaikan via AI…`, "");
    }
    if (state.highlight) highlightInPage();
    storeGet(["geminiKey"]).then(({ geminiKey }) => {
      if (geminiKey) ensureSolved(geminiKey, source);
      else setStatus(`${state.items.length} soal ketangkep • isi Gemini key di popup buat selesaikan ✨`, "warn");
    });
  }

  /* ============ 5. Overlay UI ============ */
  let els = {};
  function buildUI() {
    // Hapus UI versi lama (yang tombolnya rusak) kalau masih nyangkut di DOM —
    // ini kasus paling sering: extension di-reload tapi frame lama tetap di halaman.
    try {
      const old = document.getElementById("dh-lite-frame");
      if (old && old.dataset.fixed !== "v3") old.remove();
      document.getElementById("dh-lite-fab")?.remove();
      if (document.getElementById("dh-lite-frame")) {
        // Sudah versi terbaru, tinggal pakai ulang
        const fr = document.getElementById("dh-lite-frame");
        els.frame = fr;
        els.sub = fr.querySelector("#dh-lite-sub");
        els.status = fr.querySelector("#dh-lite-status");
        els.search = fr.querySelector("#dh-lite-search");
        els.clear = fr.querySelector("#dh-lite-clear");
        els.results = fr.querySelector("#dh-lite-results");
        els.debug = fr.querySelector("#dh-lite-debug");
        els.hl = fr.querySelector("#dh-lite-hl");
        els.fab = document.getElementById("dh-lite-fab");
        return;
      }
    } catch {}
    const frame = document.createElement("div");
    frame.id = "dh-lite-frame";
    frame.dataset.fixed = "v3";
    frame.innerHTML = `
      <div id="dh-lite-header">
        <span id="dh-lite-title">Zenith <small id="dh-lite-sub"></small></span>
        <span style="display:flex;gap:6px">
          <button type="button" id="dh-lite-min" title="Minimize">—</button>
          <button type="button" id="dh-lite-hide" title="Sembunyikan">✕</button>
        </span>
      </div>
      <div id="dh-lite-body">
        <div id="dh-lite-status">Join game seperti biasa — soal dibaca dari tabmu lalu diselesaikan AI.</div>
        <div id="dh-lite-searchrow">
          <input id="dh-lite-search" type="text" placeholder="Cari soal..." />
          <button id="dh-lite-clear" title="Hapus">✕</button>
        </div>
        <label id="dh-lite-hlrow"><input type="checkbox" id="dh-lite-hl" checked /> Highlight jawaban di halaman</label>
        <div id="dh-lite-results"></div>
        <div id="dh-lite-debug"></div>
      </div>`;
    document.documentElement.appendChild(frame);

    const fab = document.createElement("button");
    fab.id = "dh-lite-fab";
    fab.textContent = "";
    fab.title = "Zenith (Alt+H)";
    fab.setAttribute("aria-label", "Zenith");
    fab.style.setProperty("display", "none", "important");
    document.documentElement.appendChild(fab);

    els = {
      frame,
      sub: frame.querySelector("#dh-lite-sub"),
      status: frame.querySelector("#dh-lite-status"),
      search: frame.querySelector("#dh-lite-search"),
      clear: frame.querySelector("#dh-lite-clear"),
      results: frame.querySelector("#dh-lite-results"),
      debug: frame.querySelector("#dh-lite-debug"),
      hl: frame.querySelector("#dh-lite-hl"),
      fab,
    };

    const minBtn = frame.querySelector("#dh-lite-min");
    const hideBtn = frame.querySelector("#dh-lite-hide");
    const bodyEl = frame.querySelector("#dh-lite-body");
    // NOTE: content.css pakai `display: flex !important`, jadi sembunyi/minimize
    // WAJIB pakai setProperty(..., 'important') — style.display biasa kalah.
    const doMin = (e) => {
      if (e) { e.stopImmediatePropagation?.(); e.stopPropagation(); e.preventDefault(); }
      console.log("[Zenith] tombol minimize diklik v3");
      state.minimized = !state.minimized;
      bodyEl.style.setProperty("display", state.minimized ? "none" : "flex", "important");
      minBtn.textContent = state.minimized ? "+" : "—";
      minBtn.title = state.minimized ? "Expand" : "Minimize";
    };
    const doHide = (e) => {
      if (e) { e.stopImmediatePropagation?.(); e.stopPropagation(); e.preventDefault(); }
      console.log("[Zenith] tombol hide diklik v3");
      hidePanel();
    };
    // Satu wiring klik yang kuat (capture) + fallback bubble. Jangan tambah
    // stopPropagation-only listener lain — dulu itu yang bikin bingung.
    minBtn.addEventListener("click", doMin, true);
    hideBtn.addEventListener("click", doHide, true);
    minBtn.addEventListener("click", doMin, false);
    hideBtn.addEventListener("click", doHide, false);
    fab.onclick = () => showPanel();
    els.clear.onclick = () => { els.search.value = ""; render(); };
    els.search.oninput = () => render(els.search.value);
    els.hl.onchange = () => {
      state.highlight = els.hl.checked;
      if (state.highlight) highlightInPage();
      else document.querySelectorAll(".dh-lite-mark").forEach((n) => n.remove());
    };

    const header = frame.querySelector("#dh-lite-header");
    let sx = 0, sy = 0, ox = 0, oy = 0, drag = false;
    header.addEventListener("mousedown", (e) => {
      // Jangan mulai drag kalau klik tombol minimize/hide — itu yang dulu nelan klik
      if (e.target?.closest?.("button")) return;
      drag = true; sx = e.clientX; sy = e.clientY;
      const r = frame.getBoundingClientRect(); ox = r.left; oy = r.top;
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      frame.style.left = "auto"; frame.style.right = "auto";
      frame.style.left = Math.max(0, ox + e.clientX - sx) + "px";
      frame.style.top = Math.max(0, oy + e.clientY - sy) + "px";
    });
    window.addEventListener("mouseup", () => (drag = false));
  }

  function showPanel() {
    if (!els.frame) return;
    els.frame.style.setProperty("display", "flex", "important");
    if (els.fab) els.fab.style.setProperty("display", "none", "important");
    state.userHidden = false;
  }
  function hidePanel() {
    if (!els.frame) return;
    els.frame.style.setProperty("display", "none", "important");
    if (els.fab) els.fab.style.setProperty("display", "block", "important");
    state.userHidden = true;
  }
  // Hotkey stealth: Alt+H (atau Ctrl+Shift+H) toggle panel — biar bisa sembunyi cepat
  window.addEventListener("keydown", (e) => {
    try {
      const hot = (e.altKey && (e.key === "h" || e.key === "H")) ||
        (e.ctrlKey && e.shiftKey && (e.key === "h" || e.key === "H"));
      if (!hot) return;
      // Jangan ganggu saat ngetik di input halaman (kecuali input panel sendiri)
      const t = e.target;
      const inPanel = t?.closest?.("#dh-lite-frame");
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA") && !inPanel;
      if (typing) return;
      e.preventDefault();
      if (!els.frame || els.frame.style.getPropertyValue("display") === "none") showPanel();
      else hidePanel();
    } catch {}
  });
  // Panel cuma dimunculkan otomatis kalau user tidak sedang menyembunyikan
  function autoShow() {
    if (!state.userHidden) showPanel();
  }
  function dbg(t) {
    try { if (els.debug) els.debug.textContent = "net: " + t; } catch {}
  }

  function setStatus(text, kind = "") {
    if (!els.status) return;
    els.status.textContent = text;
    els.status.dataset.kind = kind;
    if (els.sub) els.sub.textContent = state.roomName ? "• " + state.roomName : "";
  }

  function render(filter = "") {
    if (!els.results) return;
    const f = (filter || els.search?.value || "").toLowerCase();
    let list = state.items;
    if (f) {
      list = list.filter((it) => {
        const q = stripHtml(it.question).toLowerCase();
        const a = [...(it.answers || []).map((x) => stripHtml(x.text)), ...(it.options || [])].join(" ").toLowerCase();
        return q.includes(f) || a.includes(f);
      });
    }
    if (!list.length) {
      els.results.innerHTML = `<div class="dh-lite-empty">${state.items.length ? "Tidak cocok." : "Belum ada soal. Join game dulu."}</div>`;
      return;
    }
    els.results.innerHTML = list.map((it, i) => {
      const qMedia = it.questionMedia ? `<br><img class="dh-lite-qimg" src="${esc(it.questionMedia)}" loading="lazy" />` : "";
      const tag = it.ai ? "AI ✨" : esc(it.tag || it.type || "");
      const ans = it.pending && !it.answers.length
        ? `<div class="dh-lite-ans dh-lite-pending">⏳ menunggu AI…</div>`
        : it.answers.length
          ? it.answers.map((a) => {
              const img = a.mediaUrl ? `<br><img class="dh-lite-aimg" src="${esc(a.mediaUrl)}" loading="lazy" />` : "";
              return `<div class="dh-lite-ans">${it.ai ? "✨ " : ""}${cleanHtml(a.text)}${img}</div>`;
            }).join("")
          : `<div class="dh-lite-ans dh-lite-none">—</div>`;
      return `<div class="dh-lite-card">
        <div class="dh-lite-qhead"><b>${i + 1}.</b> <span class="dh-lite-tag">${tag}</span></div>
        <div class="dh-lite-q">${cleanHtml(it.question) || "<i>(soal gambar — lihat highlight)</i>"}${qMedia}</div>
        ${ans}
      </div>`;
    }).join("");
    els.results.querySelectorAll("img").forEach((img) => { img.referrerPolicy = "no-referrer"; });
  }

  // Normalisasi buat COCOKIN jawaban ↔ tombol opsi:
  // minus unicode (−) → -, latex (^\circ, \mathrm{X}) → teks polos, case+spasi dirapikan.
  // Tanpa ini "-10°C" di layar vs "-10^\circ\mathrm{C}" dari AI tidak pernah exact-match.
  const normMatch = (s) => {
    let t = stripHtml(s).replace(/−/g, "-");
    t = t.replace(/\^?\\circ/g, "°").replace(/\\mathrm\{([^}]*)\}/g, "$1");
    t = t.replace(/[\\${}]/g, "");
    return t.toLowerCase().replace(/\s+/g, "");
  };

  // Teks tombol opsi: JANGAN pakai innerText mentah untuk soal rumus.
  // KaTeX menulis tiap rumus 2x di DOM (MathML tersembunyi + HTML tampil) → innerText
  // jadi dobel campur ("−9−7-9-7−9−7") dan tidak match apa-apa. Urutan baca:
  // 1) <annotation encoding="application/x-tex"> = sumber latex persis ("-9-7")
  // 2) .katex-html saja = teks tampil tanpa duplikat MathML
  // 3) innerText biasa (opsi teks polos)
  function btnText(btn) {
    try {
      const anns = [...btn.querySelectorAll("annotation")]
        .map((a) => (a.textContent || "").trim()).filter(Boolean);
      if (anns.length) return normMatch(anns.join(" "));
      const kh = btn.querySelector(".katex-html");
      if (kh && (kh.innerText || "").trim()) return normMatch(kh.innerText);
      return normMatch(btn.innerText || "");
    } catch { return ""; }
  }
  // Cari soal yang SEDANG tampil (cocokkan opsi di layar ↔ opsi tiap item).
  // Highlight dicakup ke soal ini saja — dulu jawaban 10 soal digabung semua,
  // "5" ikut nyala di "-5", "-9" ikut nyala di "-9-7" → semua opsi nyala.
  function currentItem() {
    try {
      const btns = [...document.querySelectorAll(OPT_SEL)]
        .map((b) => btnText(b)).filter(Boolean);
      if (!btns.length) return null;
      let best = null, bestScore = 0;
      for (const it of state.items) {
        const opts = new Set((it.options || []).map(normMatch).filter(Boolean));
        if (!opts.size) continue;
        const score = btns.filter((t) => opts.has(t)).length;
        if (score > bestScore) { bestScore = score; best = it; }
      }
      return bestScore > 0 ? best : null;
    } catch { return null; }
  }

  function markHit(btn) {
    btn.style.outline = "3px solid #22c55e";
    btn.style.position = btn.style.position || "relative";
    if (!btn.querySelector(":scope > .dh-lite-mark")) {
      const s = document.createElement("span");
      s.className = "dh-lite-mark";
      s.textContent = "✓";
      btn.appendChild(s);
    }
  }

  // Aturan cocok: exact dulu; fuzzy substring HANYA kalau kedua sisi ≥6 char.
  // Jawaban pendek ("5","-9") tidak boleh fuzzy — itu yang dulu bikin semua nyala.
  function isHit(t, cands) {
    if (cands.has(t)) return true;
    if (t.length < 6) return false;
    for (const c of cands) {
      if (c.length >= 6 && (t.includes(c) || c.includes(t))) return true;
    }
    return false;
  }

  function highlightInPage() {
    document.querySelectorAll(".dh-lite-mark").forEach((n) => n.remove());
    if (!state.items.length) return;
    try {
      const cur = currentItem();
      // Jalur utama: hanya jawaban soal yang sedang tampil
      const pool = cur ? [cur] : state.items;
      const cands = new Set();
      pool.forEach((it) => (it.answers || []).forEach((a) => {
        const t = normMatch(a.text);
        if (t) cands.add(t);
      }));
      if (!cands.size) return;
      const strict = !cur; // fallback: tanpa soal teridentifikasi → exact-only, tanpa fuzzy
      document.querySelectorAll(OPT_SEL).forEach((btn) => {
        const t = btnText(btn);
        if (!t) return; // tombol kosong di-skip ("".includes("") dulu bikin semua nyala)
        const hit = strict ? cands.has(t) : isHit(t, cands);
        if (hit) markHit(btn);
      });
    } catch {}
  }
  // Highlight jalan terus walau panel di-hide (stealth mode) — yang penting
  // checkbox highlight nyala, bukan panel kebuka.
  setInterval(() => { if (state.highlight && state.items.length) highlightInPage(); }, 2500);

  /* ============ 6. AI solve per soal + cache ============ */
  // Solve berantre: soal Kahoot datang beruntun tiap detik; kalau AI masih sibuk
  // mengerjakan soal sebelumnya, retry otomatis max 3x selang 4 dtk — biar tidak
  // ada soal stuck "⏳ menunggu AI…" selamanya.
  function requestSolve(source = "AI") {
    requestSolve.retries = requestSolve.retries || 0;
    storeGet(["geminiKey"]).then(({ geminiKey }) => {
      if (!geminiKey) {
        setStatus(`${state.items.length} soal ketangkep • isi Gemini key di popup buat selesaikan ✨`, "warn");
        return;
      }
      ensureSolved(geminiKey, source).then((r) => {
        if (!r?.ok && /Masih menyelesaikan/.test(r?.error || "")) {
          if (requestSolve.retries < 3) {
            requestSolve.retries++;
            setTimeout(() => requestSolve(source), 4000);
          } else {
            requestSolve.retries = 0;
            setStatus(`AI sibuk • klik Selesaikan soal di tab aktif buat retry`, "warn");
          }
        } else requestSolve.retries = 0;
      });
    });
  }
  async function ensureSolved(apiKey, source = "AI") {
    const pending = state.items.filter((x) => !x.answers?.length);
    if (!state.items.length) return { ok: false, error: "Belum ada soal ketangkep. Join game dulu." };
    if (!apiKey) return { ok: false, error: "Isi Gemini key di popup dulu." };
    if (!pending.length) return { ok: true, count: state.items.length, cached: true };
    if (state.solving) return { ok: false, error: "Masih menyelesaikan, tunggu…" };
    state.solving = true;
    try {
      const need = [];
      for (const it of pending) {
        const h = hashStr(normQ(it.question) + "|" + (it.options || []).join("|"));
        it.qhash = h;
        const hit = (await storeGet(["dh_q_" + h]))["dh_q_" + h];
        if (hit?.answer) {
          it.answers = [{ text: hit.answer, mediaUrl: null }];
          it.ai = true; it.tag = "AI ✨"; it.pending = false;
        } else need.push(it);
      }
      if (need.length) {
        // Batch kecil (8 soal) biar tiap request cepat & channel pesan nggak putus.
        // Batch yang gagal (timeout) tidak menggugurkan yang lain — bisa retry.
        const BS = 8;
        const nb = Math.ceil(need.length / BS);
        const t0 = Date.now();
        let failed = 0, lastErr = null;
        for (let b = 0; b < nb; b++) {
          const chunk = need.slice(b * BS, b * BS + BS);
          const el = Math.round((Date.now() - t0) / 1000);
          setStatus(`Menyelesaikan batch ${b + 1}/${nb} (${chunk.length} soal, ${el} dtk)…`, "");
          try {
            const cleaned = chunk.map((x) => ({ question: stripHtml(x.question), options: x.options || [] }));
            const r = await bg({ type: "SOLVE_GEMINI", apiKey, questions: cleaned });
            if (!r?.ok) throw new Error(r?.error || "Gemini gagal");
            const map = new Map((r.answers || []).map((a) => [Number(a.index), String(a.answer ?? "")]));
            chunk.forEach((it, i) => {
              const a = map.get(i + 1);
              if (a) {
                it.answers = [{ text: a, mediaUrl: null }];
                it.ai = true; it.tag = "AI ✨";
                storeSet({ ["dh_q_" + it.qhash]: { answer: a, at: Date.now() } });
              }
              it.pending = false;
            });
          } catch (e) {
            if (/HTTP (400|401|403|429)/.test(e.message || "")) throw e; // key/quota: stop semua
            lastErr = e;
            failed += chunk.length;
            chunk.forEach((it) => { it.pending = true; }); // tetap ⏳ biar bisa retry
          }
          render();
          if (state.highlight) highlightInPage();
        }
        if (failed > 0 && failed === need.length) throw lastErr || new Error("Semua batch gagal");
        if (failed > 0) {
          render();
          setStatus(`${state.items.length - failed}/${state.items.length} selesai ✨ • ${failed} gagal (timeout) — klik Selesaikan lagi buat retry`, "warn");
          if (state.highlight) highlightInPage();
          return { ok: true, count: state.items.length - failed, partial: failed };
        }
      }
      render();
      setStatus(`${state.items.length} soal di panel ✨ • ${source} • AI bisa salah, cek ulang`, "ok");
      if (state.highlight) highlightInPage();
      return { ok: true, count: state.items.length, cached: need.length === 0 };
    } catch (e) {
      setStatus(`AI gagal: ${e.message}`, "err");
      return { ok: false, error: e.message };
    } finally {
      state.solving = false;
    }
  }

  function trackFullList(items, { quizId, roomName, source }) {
    if (itemsHaveAnswers(items)) {
      setItems(items.map((x) => ({ ...x, pending: false })), { quizId, roomName, source: source + " • kunci publik ✅" });
      return;
    }
    state.items = items;
    if (quizId) state.quizId = quizId;
    if (roomName) state.roomName = roomName;
    render();
    setStatus(`${items.length} soal ketangkep • ${source} • menyelesaikan via AI…`, "");
    if (state.highlight) highlightInPage();
    storeGet(["geminiKey"]).then(({ geminiKey }) => {
      if (geminiKey) ensureSolved(geminiKey, source);
      else setStatus(`${items.length} soal ketangkep • isi Gemini key di popup buat selesaikan ✨`, "warn");
    });
  }

  async function handleRoom(room, source) {
    if (!room) return;
    if (room.name) state.roomName = room.name;
    const items = fromRoomObject(room.questions);
    if (items?.length) {
      trackFullList(items, { roomName: room.name || "", source: source + " • live" });
      return;
    }
    const quizId = room.quizId || room.quizID || state.quizId;
    if (quizId) { await fetchPublicQuiz(quizId, source); return; }
    if (room.hash) {
      try {
        const r = await bg({ type: "FETCH_QUIZID_BY_HASH", hash: room.hash });
        if (r?.ok) { await fetchPublicQuiz(r.quizId, source); return; }
      } catch {}
    }
    setStatus(`Masuk: ${room.name || "lobby"} • nunggu soal (quiz-info/socket)…`, "");
  }

  function handleRejoinRaw(raw) {
    const room = raw?.data?.room;
    if (room && (room.questions || room.quizId || room.quizID || room.hash || room.name)) {
      handleRoom(room, "rejoin");
      return;
    }
    const items = extractQuizInfo(raw);
    if (items?.length) mergeItems(items, "rejoin");
    else if (room?.name || raw?.data) {
      if (raw?.data?.room?.name) state.roomName = raw.data.room.name;
      setStatus(`Masuk lobby${state.roomName ? ": " + state.roomName : ""} • nunggu soal (quiz-info/socket)…`, "");
    }
  }

  async function fetchPublicQuiz(quizId, source = "publik") {
    setStatus(`Mengambil soal quiz ${quizId} (tanpa join)…`, "");
    const r = await bg({ type: "FETCH_WAYGROUND_QUIZ", quizId });
    if (r?.ok) handleRawWayground(r.questions, quizId, source);
    else setStatus(`Gagal: ${r?.error || "unknown"}`, "err");
  }

  function handleRawWayground(rawQuestions, quizId, source) {
    const items = fromWaygroundQuestions(rawQuestions);
    if (items?.length) {
      autoShow();
      trackFullList(items, { quizId, source });
    }
    else setStatus("Quiz ketemu tapi soalnya kosong.", "warn");
  }

  /* Kahoot live (cometd): soal datang satu per satu saat game jalan.
     Tanpa kunci publik (server Kahoot tidak pernah kirim jawaban) → murni AI. */
  function handleKahootLive(p) {
    const title = stripHtml(p.title || "");
    const choices = (p.choices || [])
      .map((c) => stripHtml(typeof c === "string" ? c : (c?.answer || "")))
      .filter(Boolean);
    if (!title && !choices.length) return;
    autoShow();
    const item = {
      question: p.title || "", questionMedia: null, answers: [],
      options: p.choices || [], type: "quiz", tag: "KAHOOT",
      ai: false, pending: true,
      qindex: (p.questionIndex ?? null) !== null ? p.questionIndex : null,
    };
    const nq = normQ(title);
    // Dedup 2 namespace: nomor soal (#ki) ATAU teks soal. Kahoot kadang kirim soal
    // yang sama 2x dengan format beda (sekali tanpa questionIndex, sekali dengan) —
    // cek salah satu saja bikin tiap soal kembar 2.
    let ex = null;
    if (item.qindex !== null) ex = state.items.find((it) => (it.qindex ?? null) === item.qindex);
    if (!ex && nq) ex = state.items.find((it) => normQ(it.question) === nq);
    if (ex) {
      if ((ex.qindex ?? null) === null && item.qindex !== null) ex.qindex = item.qindex;
      if (!ex.options?.length && choices.length) {
        ex.question = item.question; ex.options = item.options;
        render();
      } else return; // duplikat
    } else {
      state.items.push(item);
      render();
    }
    const n = item.qindex !== null ? (" #" + (item.qindex + 1)) : "";
    setStatus(`Kahoot soal${n} ketangkep • menyelesaikan via AI…`, "");
    if (state.highlight) highlightInPage();
    requestSolve("kahoot-live");
  }

  /* Fallback Kahoot: baca soal yang tampil di HP (mode tampil-soal-di-HP).
     Selector dari controller v2: data-functional-selector. */
  const KAHOOT_Q_SEL = '[data-functional-selector="question-title"],[data-functional-selector="block-title"],[data-functional-selector*="question-title"]';
  const KAHOOT_OPT_SEL = '[data-functional-selector="answer-option"],[data-functional-selector^="question-choice"]';
  // Wayground ([data-cy^="option-"]) + Kahoot (data-functional-selector) sekaligus
  const OPT_SEL = '[data-cy^="option-"],[data-functional-selector="answer-option"],[data-functional-selector^="question-choice"],button[data-functional-selector*="answer"],button[data-functional-selector*="choice"]';
  function scrapeKahootVisible() {
    try {
      const t = document.querySelector(KAHOOT_Q_SEL);
      const title = (t?.innerText || "").trim();
      const opts = [...document.querySelectorAll(KAHOOT_OPT_SEL)]
        .map((b) => (b.innerText || "").trim()).filter(Boolean);
      if (title && opts.length >= 2) return { title, choices: opts };
    } catch {}
    return null;
  }

  /* Fallback: baca soal yang sedang tampil di DOM */
  function scrapeVisible() {
    try {
      const qEl = document.querySelector('[data-quesid], .question-text, [class*="question"]');
      const qText = qEl?.innerText?.trim() || "";
      const btns = [...document.querySelectorAll('[data-cy^="option-"]')];
      const opts = btns.map((b) => (b.innerText || "").trim()).filter(Boolean);
      if (qText && opts.length >= 2) {
        return [{ question: qText, questionMedia: null, answers: [], options: opts, type: "MCQ", tag: "MCQ", ai: false, pending: true }];
      }
    } catch {}
    return null;
  }

  /* ============ 7. Pesan dari popup ============ */
  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    (async () => {
      if (msg?.type === "PING") { sendResponse({ ok: true, count: state.items.length }); return; }
      if (msg?.type === "TRIGGER_SOLVE") {
        showPanel(); // user explicitly asked -> override hidden
        if (!state.items.length) {
          const scraped = scrapeVisible();
          if (scraped) mergeItems(scraped, "layar");
          else {
            const k = scrapeKahootVisible();
            if (k) { handleKahootLive({ ...k, questionIndex: null }); }
            else { sendResponse({ ok: false, error: "Belum ada soal ketangkep. Join game dulu." }); return; }
          }
        }
        await new Promise((r) => setTimeout(r, 300));
        sendResponse(await ensureSolved(msg.apiKey, "tab"));
        return;
      }
      if (msg?.type === "SOLVE_RAW_QUESTIONS") {
        const items = msg.kind === "kahoot"
          ? fromKahoot(msg.rawQuestions)
          : fromWaygroundQuestions(msg.rawQuestions);
        if (!items?.length) { sendResponse({ ok: false, error: "Format soal tidak dikenali." }); return; }
        autoShow();
        trackFullList(items, { quizId: msg.quizId, source: "popup" });
        await new Promise((r) => setTimeout(r, 300));
        sendResponse(await ensureSolved(msg.apiKey, "popup"));
        return;
      }
      sendResponse({ ok: false });
    })();
    return true;
  });

  /* ============ 8. Init ============ */
  buildUI();
  requestHook();
  const bootCache = () => {
    try {
      const prev = localStorage.getItem("previousContext");
      if (prev) {
        const qid = JSON.parse(prev)?.game?.quizId;
        if (qid) fetchPublicQuiz(qid, "cache");
      }
    } catch {}
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(bootCache, 1500));
  else setTimeout(bootCache, 1500);
  console.log("%c[Zenith] ready", "color:#6b7280;font-weight:bold");
})();
