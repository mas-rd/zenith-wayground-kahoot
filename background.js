// DitHack Lite — background service worker (MV3) — GEMINI ONLY, NO BOT JOIN
// Tidak ada CheatNetwork. Tidak ada yang join ke game selain kamu.
// Background hanya: (1) GET quiz publik (tanpa join), (2) call Gemini pakai key user.

/** Quiz publik Wayground/Quizizz (GET biasa, bukan join). */
async function fetchWaygroundQuiz(quizId) {
  const id = String(quizId).trim();
  const urls = [
    `https://wayground.com/api/main/quiz/${encodeURIComponent(id)}`,
    `https://quizizz.com/api/main/quiz/${encodeURIComponent(id)}`,
  ];
  const errors = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) {
        errors.push(`${url} -> HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      const questions =
        data?.data?.quiz?.info?.questions ||
        data?.data?.quizInfo?.questions ||
        data?.data?.questions ||
        null;
      if (questions && questions.length) return { ok: true, url, raw: data, questions };
      errors.push(`${url} -> kosong`);
    } catch (e) {
      errors.push(`${url} -> ${e.message}`);
    }
  }
  return { ok: false, error: "Quiz publik tidak ditemukan. " + errors.join(" | ") };
}

/** Room hash solo -> quizId via endpoint publik (GET biasa, bukan join). */
async function fetchQuizIdByHash(hash) {
  const h = String(hash).trim();
  const url = `https://wayground.com/_gameapi/main/public/v1/students/games/${encodeURIComponent(h)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const quizId =
    data?.data?.items?.[0]?.quizId ||
    Object.values(data?.data?.quizzes || {})?.[0]?.id ||
    null;
  if (!quizId) throw new Error("quizId tidak ketemu dari hash");
  return { quizId, raw: data };
}

/** Kahoot publik via ID (GET biasa, bukan join). */
async function fetchKahootQuiz(kahootId) {
  const id = String(kahootId).trim();
  const urls = [
    `https://kahoot.it/rest/kahoots/${encodeURIComponent(id)}`,
    `https://create.kahoot.it/rest/kahoots/${encodeURIComponent(id)}/card/?includeKahoot=true`,
  ];
  const errors = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) {
        errors.push(`${url} -> HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      const questions = data?.questions || data?.kahoot?.questions || null;
      if (questions?.length) return { ok: true, url, raw: data, questions };
      errors.push(`${url} -> kosong`);
    } catch (e) {
      errors.push(`${url} -> ${e.message}`);
    }
  }
  return { ok: false, error: "Kahoot tidak ditemukan. " + errors.join(" | ") };
}

const GEMINI_MODELS = ["gemini-3.6-flash", "gemini-3.8-flash", "gemini-3.7-flash", "gemini-2.5-flash", "gemini-2.0-flash"];

/** Tanya ke Google: model apa saja yang bisa dipakai key ini? (anti-404 kalau nama model ganti) */
async function listGeminiModels(apiKey) {
  for (const ver of ["v1beta", "v1"]) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/${ver}/models?key=${encodeURIComponent(apiKey)}&pageSize=100`
    );
    if (res.status === 404) continue;
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`ListModels HTTP ${res.status} ${t.slice(0, 200)}`);
    }
    const data = await res.json();
    const names = (data?.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => String(m.name || "").replace(/^models\//, ""))
      .filter(Boolean);
    if (names.length) return names;
  }
  return [];
}

/** Skor versi buat urutan: stabil + tertinggi dulu (3.6 > 3.5 > ...). */
function modelScore(n) {
  const m = String(n).match(/(\d+)\.(\d+)/);
  const stable = /exp|preview|rc|thinking/i.test(n) ? 0 : 1;
  return stable * 1e6 + (m ? +m[1] * 1e3 + +m[2] : 0);
}

function buildPrompt(questions) {
  const list = questions
    .map((q, i) => {
      const opts = q.options.length ? q.options.join(" | ") : "(isian — tulis jawaban singkat)";
      return `${i + 1}. ${q.question}\n   Opsi: ${opts}`;
    })
    .join("\n");
  return (
    "Kamu asisten kuis. Jawab tiap soal dengan memilih teks opsi yang paling benar (salin persis). " +
    "Untuk soal isian tanpa opsi, tulis jawaban singkat yang benar. " +
    'Balas HANYA JSON array seperti [{"index":1,"answer":"..."}]. Tanpa markdown, tanpa penjelasan.\n' +
    list
  );
}

function parseGeminiJson(text) {
  const clean = String(text || "").replace(/```json|```/g, "").trim();
  const m = clean.match(/\[[\s\S]*\]/);
  if (!m) throw new Error("Respon AI tidak bisa diparse.");
  return JSON.parse(m[0]);
}

async function callGemini(apiKey, prompt) {
  // Kandidat = model yang terbukti jalan sblmnya + hasil discovery (flash terbaru dulu) + fallback hardcoded.
  const candidates = [];
  try {
    const stored = await new Promise((res) => chrome.storage.local.get(["dh_model"], (v) => res(v?.dh_model)));
    if (stored) candidates.push(stored);
  } catch {}
  try {
    const names = await listGeminiModels(apiKey);
    const flashes = names.filter((n) => /flash/i.test(n));
    const pool = flashes.length ? flashes : names;
    for (const n of [...new Set(pool)].sort((a, b) => modelScore(b) - modelScore(a))) {
      if (!candidates.includes(n)) candidates.push(n);
    }
  } catch (e) {
    // Key/quota salah -> langsung lapor, jangan buang waktu coba-coba
    if (/ListModels HTTP (400|401|403|429)/.test(e.message)) throw e;
  }
  for (const m of GEMINI_MODELS) if (!candidates.includes(m)) candidates.push(m);
  // Coba satu-satu: 404 = model pensiun -> lanjut; 400/401/403/429 = key/quota -> stop.
  let lastErr = null;
  for (const model of candidates.slice(0, 8)) {
    try {
      const out = await tryModel(apiKey, model, prompt);
      try { await new Promise((res) => chrome.storage.local.set({ dh_model: model }, () => res())); } catch {}
      return out;
    } catch (e) {
      lastErr = e;
      if (/HTTP (400|401|403|429)/.test(e.message)) throw e;
    }
  }
  throw lastErr || new Error("Semua model Gemini gagal.");
}

async function tryModel(apiKey, model, prompt) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 90000);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctl.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 1500 },
        }),
      }
    );
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Gemini [${model}] HTTP ${res.status} ${t.slice(0, 200)}`);
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((x) => x.text || "").join("") || "";
    if (!text) throw new Error(`Gemini [${model}] respon kosong.`);
    return { text, model };
  } catch (e) {
    if (e?.name === "AbortError") throw new Error(`Gemini [${model}] timeout 90 dtk`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Batch: 1 request untuk banyak soal (cepat), chunk 25 soal biar aman. */
async function solveWithGemini(apiKey, questions) {
  const qs = questions.slice(0, 60);
  const out = [];
  for (let s = 0; s < qs.length; s += 10) {
    const chunk = qs.slice(s, s + 10);
    const { text, model } = await callGemini(apiKey, buildPrompt(chunk));
    const arr = parseGeminiJson(text);
    arr.forEach((a) => {
      const idx = Number(a.index) - 1 + s;
      if (qs[idx]) out.push({ index: idx + 1, answer: String(a.answer ?? "") });
    });
  }
  return out;
}

const GAME_URL_RE = /wayground\.com|quizizz\.com|kahoot\.(it|com)/;

/** Suntik hook.js ke MAIN world tab (jalur resmi, kebal CSP halaman). */
async function injectHook(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    files: ["hook.js"],
  });
}

// Auto-suntik tiap navigasi ke halaman game (hook dipasang sebelum user join)
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "loading" || !tab?.url || !GAME_URL_RE.test(tab.url)) return;
  injectHook(tabId).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "INJECT_HOOK") {
        const tabId = sender?.tab?.id;
        if (!tabId) throw new Error("no tab");
        await injectHook(tabId);
        sendResponse({ ok: true });
        return;
      }
      switch (msg?.type) {
        case "FETCH_WAYGROUND_QUIZ": {
          sendResponse(await fetchWaygroundQuiz(msg.quizId));
          break;
        }
        case "FETCH_QUIZID_BY_HASH": {
          sendResponse({ ok: true, ...(await fetchQuizIdByHash(msg.hash)) });
          break;
        }
        case "FETCH_KAHOOT_QUIZ": {
          sendResponse(await fetchKahootQuiz(msg.kahootId));
          break;
        }
        case "TEST_GEMINI": {
          const { text, model } = await callGemini(msg.apiKey, 'Balas HANYA: [{"index":1,"answer":"ok"}]');
          sendResponse({ ok: true, model, parsed: parseGeminiJson(text) });
          break;
        }
        case "SOLVE_GEMINI": {
          if (!msg.apiKey) throw new Error("API key Gemini belum diisi.");
          if (!msg.questions?.length) throw new Error("Tidak ada soal untuk diselesaikan.");
          sendResponse({ ok: true, answers: await solveWithGemini(msg.apiKey, msg.questions) });
          break;
        }
        default:
          sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true;
});
