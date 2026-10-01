/* DitHack Lite — hook.js (jalan di MAIN world via chrome.scripting, kebal CSP)
 * - Bypass anti tab-switch / fullscreen
 * - Sadap XHR/fetch game (join/rejoin/quiz-info/attempt) + sniff websocket
 * - Kirim hasil ke content script lewat window.postMessage
 */
(() => {
  if (window.__dhLiteHooked) return;
  window.__dhLiteHooked = true;

  try {
    const BLOCK = ["blur", "focus", "visibilitychange", "focusin", "focusout", "fullscreenchange", "fullscreenerror", "contextmenu"];
    const wAdd = window.addEventListener.bind(window);
    const dAdd = document.addEventListener.bind(document);
    const etAdd = EventTarget.prototype.addEventListener;
    window.addEventListener = (t, l, o) => (BLOCK.includes(t) ? undefined : wAdd(t, l, o));
    document.addEventListener = (t, l, o) => (BLOCK.includes(t) ? undefined : dAdd(t, l, o));
    EventTarget.prototype.addEventListener = function (t, l, o) {
      if (BLOCK.includes(t)) return undefined;
      return etAdd.call(this, t, l, o);
    };
    Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
    Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
    if (Element.prototype.requestFullscreen) Element.prototype.requestFullscreen = () => Promise.reject(new Error("blocked"));
    if (document.exitFullscreen) document.exitFullscreen = () => Promise.resolve();
  } catch (e) {}

  const post = (kind, payload) => {
    try { window.postMessage({ __dhLite: true, kind, payload }, "*"); } catch (e) {}
  };

  const JOIN = /play-api\/v5\/join/;
  const REJOIN = /_gameapi\/main\/public\/v1\/games\/([a-f0-9]+)\/rejoin/;
  const QUIZINFO = /_gameapi\/main\/public\/v1\/games\/([a-f0-9]+)\/quiz-info/;
  const SOLO = /play-api\/v4\/soloJoin/;
  const ATTEMPT = /_gameapi\/main\/public\/v1\/students\/attempts\/([a-f0-9]{24})/;
  const QUIZAPI = /\/api\/main\/quiz\/([^/?#]+)/;
  const SOCKETPOLL = /socket\.io|_gsocket/;
  // Kahoot live (cometd/Bayeux WS + reserve/session). Jawaban benar TIDAK PERNAH
  // dikirim ke pemain (validasi server-side) — yang disadap cuma teks soal + opsi
  // (mode "show questions on players' devices"), kunci tetap dari AI.
  const KAHOOT_RESERVE = /kahoot\.it\/reserve\/session\/(\d+)/;

  const emit = (url, body, text) => {
    try {
      if (SOCKETPOLL.test(url)) { sniffWs(text); return; }
      const mRes = url.match(KAHOOT_RESERVE);
      if (mRes) { post("kahootPin", { pin: mRes[1] }); return; }
      if (SOLO.test(url)) {
        try { const b = JSON.parse(body); if (b?.quizId) post("soloQuizId", { quizId: b.quizId }); } catch (e) {}
        return;
      }
      const data = JSON.parse(text);
      if (JOIN.test(url) && data?.room) post("room", { room: data.room, source: "join" });
      else if (REJOIN.test(url) && data?.data?.room) post("room", { room: data.data.room, source: "rejoin" });
      else if (REJOIN.test(url)) post("rejoinRaw", { raw: data });
      else if (QUIZINFO.test(url)) post("quizInfoRaw", { raw: data });
      else if (ATTEMPT.test(url) && data?.data?.quizInfo?.quizId) post("quizId", { quizId: data.data.quizInfo.quizId, source: "attempt" });
      else if (QUIZAPI.test(url)) {
        const m = url.match(QUIZAPI);
        const qs = data?.data?.quiz?.info?.questions;
        if (qs?.length) post("quizQuestions", { quizId: m[1], questions: qs });
      }
    } catch (e) {}
  };

  // Kahoot cometd/Bayeux: [{channel:"/service/player", data:{id, content:"{...}"}}]
  // content adalah JSON string ganda → parse 2x. id 1=GetReady, 2=QuestionStart
  // (cuma questionIndex), type=quiz + title + choices = soal full.
  // Return true kalau teks ini message Bayeux Kahoot (biar parser umum skip).
  function sniffKahootWs(text) {
    try {
      if (typeof text !== "string") return false;
      const s = text.trim();
      if (!s || s[0] !== "[") return false;
      let arr;
      try { arr = JSON.parse(s); } catch (e) { return false; }
      if (!Array.isArray(arr) || !arr.length) return false;
      if (!arr.some((m) => m && typeof m.channel === "string" &&
        (m.channel.indexOf("/service/") === 0 || m.channel.indexOf("/meta/") === 0))) return false;
      for (const m of arr) {
        try {
          const d = m.data;
          if (!d || d.content == null) continue;
          const raw = d.content;
          const content = typeof raw === "string" ? JSON.parse(raw) : raw;
          if (!content || typeof content !== "object") continue;
          const qi = typeof content.questionIndex === "number" ? content.questionIndex
            : (typeof content.questionNumber === "number" ? content.questionNumber : null);
          if (content.type === "quiz" && content.title &&
              Array.isArray(content.choices) && content.choices.length) {
            post("kahootQuestion", {
              title: String(content.title),
              choices: content.choices
                .map((c) => (typeof c === "string" ? c : (c && c.answer) || ""))
                .filter(Boolean),
              questionIndex: qi,
            });
          } else if (qi !== null && (d.id === 1 || d.id === 2)) {
            post("kahootIndex", { questionIndex: qi });
          }
        } catch (e) {}
      }
      return true;
    } catch (e) { return false; }
  }

  // Cari struktur soal di pesan websocket / socket-polling (engine.io: prefix angka + JSON)
  let lastWsPost = 0;
  function sniffWs(text) {
    try {
      if (typeof text !== "string" || text.length < 20 || text.length > 500000) return;
      const s = text.replace(/^\d+/, "");
      if (!s || (s[0] !== "{" && s[0] !== "[")) return;
      let obj;
      try { obj = JSON.parse(s); } catch (e) { return; }
      const found = [];
      const visit = (n, d) => {
        if (!n || d > 5 || found.length >= 10) return;
        if (Array.isArray(n)) {
          if (n.length && n.every((x) => x && typeof x === "object" && (x.question || x.query || x.structure))) {
            found.push(...n.slice(0, 60));
            return;
          }
          for (const x of n) visit(x, d + 1);
          return;
        }
        if (typeof n === "object") {
          if (typeof n.question === "string" && (n.options || n.choices)) { found.push(n); return; }
          if (n.structure && n.structure.query) { found.push(n); return; }
          for (const k in n) {
            if (k === "room" || k === "player" || k === "players") continue;
            visit(n[k], d + 1);
            if (found.length >= 10) return;
          }
        }
      };
      visit(obj, 0);
      if (!found.length) return;
      const now = Date.now();
      if (now - lastWsPost < 2000) return;
      lastWsPost = now;
      post("wsQuestions", { questions: found.slice(0, 60) });
    } catch (e) {}
  }

  const oOpen = XMLHttpRequest.prototype.open;
  const oSend = XMLHttpRequest.prototype.send;
  const KH_URL = (u) => JOIN.test(u) || REJOIN.test(u) || QUIZINFO.test(u) || ATTEMPT.test(u) || QUIZAPI.test(u) || SOLO.test(u) || SOCKETPOLL.test(u) || KAHOOT_RESERVE.test(u);
  XMLHttpRequest.prototype.open = function (m, u, ...r) {
    try { this._dhUrl = String(u); } catch (e) {}
    return oOpen.call(this, m, u, ...r);
  };
  XMLHttpRequest.prototype.send = function (b) {
    try {
      const url = this._dhUrl || "";
      if (KH_URL(url)) {
        this.addEventListener("load", function () {
          try { emit(url, b, this.responseText); } catch (e) {}
        });
      }
    } catch (e) {}
    return oSend.call(this, b);
  };

  const oFetch = window.fetch;
  window.fetch = async function (...a) {
    const res = await oFetch.apply(this, a);
    try {
      const url = String((a[0] && a[0].url) || a[0] || "");
      if (KH_URL(url)) {
        res.clone().text().then((t) => emit(url, null, t)).catch(() => {});
      }
    } catch (e) {}
    return res;
  };

  // WebSocket live (soal bisa datang per soal saat game mulai; Kahoot via cometd)
  try {
    const OWS = window.WebSocket;
    window.WebSocket = new Proxy(OWS, {
      construct(t, args) {
        const ws = new t(...args);
        try {
          ws.addEventListener("message", (ev) => {
            try {
              if (sniffKahootWs(ev.data)) return;
              sniffWs(ev.data);
            } catch (e) {}
          });
        } catch (e) {}
        return ws;
      },
    });
  } catch (e) {}
})();
