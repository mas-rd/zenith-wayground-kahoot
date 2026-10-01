// DitHack Lite — popup GEMINI ONLY. Tidak ada bot join, tidak ada CheatNetwork.
let mode = "quizizz";

const $ = (id) => document.getElementById(id);
const status = (t, cls = "") => {
  const el = $("status");
  el.textContent = t;
  el.className = cls;
};
const bg = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(r || { ok: false })));

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** Kirim pesan ke tab; kalau content script belum ada (tab dibuka sebelum install/reload),
    inject manual lalu coba lagi. */
async function sendToTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    const m = String(e?.message || e);
    if (!/receiving end|no receiver|connection/i.test(m)) throw e;
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }).catch(() => {});
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] }).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    return await chrome.tabs.sendMessage(tabId, msg); // kalau ini masih gagal -> bukan halaman game
  }
}

function extractWaygroundId(input) {
  const s = (input || "").trim();
  if (!s) return null;
  const m = s.match(/\/quiz\/([a-f0-9]{16,40})/i) || s.match(/quizId=([a-f0-9]+)/i);
  if (m) return m[1];
  if (/^[a-f0-9]{20,40}$/i.test(s)) return s;
  return null;
}
function extractKahootId(input) {
  const s = (input || "").trim();
  if (!s) return null;
  const m = s.match(/kahoot\.it\/[^/]*\/([0-9a-f-]{10,})/i) || s.match(/challenge\/([0-9a-f-]{10,})/i);
  if (m) return m[1];
  if (/^[0-9a-f-]{10,}$/i.test(s)) return s;
  return null;
}

$("tab-wg").onclick = () => {
  mode = "quizizz";
  $("tab-wg").classList.add("active"); $("tab-kh").classList.remove("active");
  $("pin").placeholder = "Link quiz / quiz ID (opsional)…";
};
$("tab-kh").onclick = () => {
  mode = "kahoot";
  $("tab-kh").classList.add("active"); $("tab-wg").classList.remove("active");
  $("pin").placeholder = "Kahoot ID / link challenge (opsional)…";
};

chrome.storage.local.get(["geminiKey"], (v) => {
  if (v.geminiKey) $("gemini").value = v.geminiKey;
});

$("save").onclick = () => {
  const k = $("gemini").value.trim();
  if (!k) return status("Isi key dulu.", "err");
  chrome.storage.local.set({ geminiKey: k }, () => status("Key tersimpan lokal ✅", "ok"));
};

$("test").onclick = async () => {
  const k = $("gemini").value.trim();
  if (!k) return status("Isi key dulu.", "err");
  status("Ngetes key…");
  const r = await bg({ type: "TEST_GEMINI", apiKey: k });
  if (r?.ok) {
    chrome.storage.local.set({ geminiKey: k });
    status(`Key valid ✅ (model: ${r.model || "?"})`, "ok");
  } else status(`Key gagal: ${r?.error || "unknown"}`, "err");
};

$("pin").addEventListener("keydown", (e) => { if (e.key === "Enter") $("go").click(); });

$("show").onclick = async () => {
  const tab = await activeTab();
  if (!tab?.id) return status("Tab tidak ketemu.", "err");
  const { geminiKey } = await chrome.storage.local.get(["geminiKey"]);
  if (!geminiKey) return status("Isi + simpan Gemini key dulu.", "err");
  status("Menyelesaikan soal di tab… (batch 1x, ±detik)");
  try {
    const r = await sendToTab(tab.id, { type: "TRIGGER_SOLVE", apiKey: geminiKey });
    if (r?.ok) status(`${r.count} soal selesai ✨${r.cached ? " (dari cache, instan)" : ""}`, "ok");
    else status(r?.error || "Belum ada soal ketangkep. Join game dulu.", "err");
  } catch {
    status("Buka halaman wayground/quizizz/kahoot dulu.", "err");
  }
};

$("go").onclick = async () => {
  const btn = $("go");
  const key = $("gemini").value.trim();
  if (!key) return status("Isi Gemini key dulu.", "err");
  chrome.storage.local.set({ geminiKey: key });
  const input = $("pin").value.trim();
  const tab = await activeTab();
  btn.disabled = true;

  try {
    // Jalur A: ada link/ID quiz publik -> fetch (GET biasa, bukan join) -> solve -> tampilkan
    const qid = mode === "quizizz" ? extractWaygroundId(input) : extractKahootId(input);
    if (qid) {
      status("Mengambil soal publik (tanpa join)…");
      const fetched =
        mode === "quizizz"
          ? await bg({ type: "FETCH_WAYGROUND_QUIZ", quizId: qid })
          : await bg({ type: "FETCH_KAHOOT_QUIZ", kahootId: qid });
      const rawQs = fetched?.questions;
      if (!fetched?.ok || !rawQs?.length) {
        status(`Gagal ambil quiz: ${fetched?.error || "unknown"}`, "err");
        return;
      }
      status(`Menyelesaikan ${rawQs.length} soal (±detik, 1 batch)…`);
      await sendToTab(tab.id, { type: "SOLVE_RAW_QUESTIONS", apiKey: key, rawQuestions: rawQs, quizId: qid, kind: mode });
      status(`${rawQs.length} soal dikirim ke tab ✨`, "ok");
      return;
    }
    // Jalur B: PIN live / kosong -> selesaikan yang sudah ketangkep di tab (wajib join dulu, tanpa bot)
    if (/^\d{4,10}$/.test(input)) {
      status("PIN live tidak bisa di-resolve tanpa join (tanpa bot). Join dulu di tab, lalu klik 'Selesaikan soal di tab aktif'.", "err");
      return;
    }
    status("Menyelesaikan soal di tab…");
    const r = await sendToTab(tab.id, { type: "TRIGGER_SOLVE", apiKey: key });
    if (r?.ok) status(`${r.count} soal selesai ✨${r.cached ? " (dari cache, instan)" : ""}`, "ok");
    else status(r?.error || "Belum ada soal ketangkep. Join game dulu.", "err");
  } catch (e) {
    status(`Error: ${e.message}`, "err");
  } finally {
    btn.disabled = false;
  }
};
