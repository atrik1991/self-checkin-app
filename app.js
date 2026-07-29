// ==== 設定 ====
const SUPABASE_URL = "https://eabpkpfshikhhpowljan.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVhYnBrcGZzaGlraGhwb3dsamFuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM5MDM1NDksImV4cCI6MjA5OTQ3OTU0OX0.BkmWZf_EVFLZ8UrkftcLnmEl0e3WhppGAI0dKL10TFg";
const VAPID_PUBLIC_KEY =
  "BJAgBlwx6vt5wI7j5RPPrX_zeicMtp0JBWNrli-jQbWbQsf4X6j7cF8woJXlunn331eSOrN3DDAKmvbtpoXfm1U";

const HISTORY_DAYS = 5; // UI上で遡れる日数
const CHOICE_SEP = "、"; // 複数選択の保存・表示に使う区切り(選択肢の文言に含まれない文字)

const CATEGORY_META = {
  mood: { label: "気分", emoji: "😊" },
  health: { label: "健康", emoji: "💪" },
  thoughts: { label: "考えごと", emoji: "💭" },
  hobby: { label: "趣味", emoji: "🎨" },
  future: { label: "未来", emoji: "🚀" },
  relationship: { label: "人間関係", emoji: "🤝" },
  growth: { label: "学び", emoji: "📚" },
  work: { label: "仕事", emoji: "💼" },
  money: { label: "お金", emoji: "💰" },
  values: { label: "価値観", emoji: "⭐️" },
  daily: { label: "今日", emoji: "☀️" },
  general: { label: "くらし", emoji: "🌱" },
};

const $ = (sel) => document.querySelector(sel);

function sbHeaders(extra = {}) {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders() });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}

async function sbInsert(table, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: sbHeaders({ Prefer: "return=minimal" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`INSERT ${table} failed: ${res.status} ${await res.text()}`);
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function showToast(msg) {
  const toast = $("#toast");
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2000);
}

// ==== 出題 ====
let allQuestions = [];
let currentQuestion = null;
let selectedValue = null; // choice/scale の選択値(1始まり)
let selectedLabel = null;

async function loadAllQuestions() {
  allQuestions = await sbGet(
    "checkin_questions?active=eq.true&select=id,text,qtype,options,category"
  );
}

function pickRandomQuestion() {
  const pool = allQuestions.filter((q) => !currentQuestion || q.id !== currentQuestion.id);
  const src = pool.length > 0 ? pool : allQuestions;
  return src[Math.floor(Math.random() * src.length)] || null;
}

async function setQuestionFromUrlOrRandom() {
  const params = new URLSearchParams(location.search);
  const qId = params.get("q");
  if (qId) {
    const found = allQuestions.find((q) => String(q.id) === String(qId));
    if (found) {
      currentQuestion = found;
      return;
    }
  }
  currentQuestion = pickRandomQuestion();
}

function renderQuestion() {
  const badge = $("#question-badge");
  const area = $("#input-area");
  selectedValue = null;
  selectedLabel = null;

  if (!currentQuestion) {
    $("#question-text").textContent = "質問を読み込めませんでした";
    area.innerHTML = "";
    badge.style.display = "none";
    $("#submit-btn").disabled = true;
    return;
  }

  const meta = CATEGORY_META[currentQuestion.category] || CATEGORY_META.general;
  badge.style.display = "inline-flex";
  badge.textContent = `${meta.emoji} ${meta.label}`;
  $("#question-text").textContent = currentQuestion.text;

  area.innerHTML = "";
  const qtype = currentQuestion.qtype || "text";

  if (qtype === "text") {
    const ta = document.createElement("textarea");
    ta.id = "answer-input";
    ta.placeholder = "思ったことをそのまま書いてOK";
    ta.addEventListener("input", () => {
      $("#submit-btn").disabled = ta.value.trim().length === 0;
    });
    area.appendChild(ta);
    $("#submit-btn").disabled = true;
  } else if (qtype === "choice") {
    const opts = currentQuestion.options || {};
    const choices = opts.choices || [];
    const isMulti = opts.multi === true;
    const picked = new Set();

    const wrap = document.createElement("div");
    wrap.className = "choices";
    choices.forEach((c, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "choice-btn";
      btn.textContent = c;
      btn.addEventListener("click", () => {
        if (isMulti) {
          if (picked.has(c)) {
            picked.delete(c);
            btn.classList.remove("selected");
          } else {
            picked.add(c);
            btn.classList.add("selected");
          }
          // 選択順ではなく選択肢の並び順で保存して、表示のブレをなくす
          selectedLabel = choices.filter((x) => picked.has(x)).join(CHOICE_SEP);
          selectedValue = null; // 複数選択では単一の数値に落とせないので持たない
          $("#submit-btn").disabled = picked.size === 0;
        } else {
          wrap.querySelectorAll(".choice-btn").forEach((b) => b.classList.remove("selected"));
          btn.classList.add("selected");
          selectedValue = i + 1;
          selectedLabel = c;
          $("#submit-btn").disabled = false;
        }
      });
      wrap.appendChild(btn);
    });
    area.appendChild(wrap);

    if (isMulti) {
      const hint = document.createElement("div");
      hint.className = "multi-hint";
      hint.textContent = "あてはまるものをいくつでも選べます";
      area.appendChild(hint);
    }
    $("#submit-btn").disabled = true;
  } else if (qtype === "scale") {
    const opts = currentQuestion.options || {};
    const row = document.createElement("div");
    row.className = "scale-row";
    for (let n = 1; n <= 5; n++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "scale-btn";
      btn.textContent = n;
      btn.addEventListener("click", () => {
        row.querySelectorAll(".scale-btn").forEach((b) => b.classList.remove("selected"));
        btn.classList.add("selected");
        selectedValue = n;
        selectedLabel = String(n);
        $("#submit-btn").disabled = false;
      });
      row.appendChild(btn);
    }
    const labels = document.createElement("div");
    labels.className = "scale-labels";
    labels.innerHTML = `<span>${escapeHtml(opts.min || "低い")}</span><span>${escapeHtml(
      opts.max || "高い"
    )}</span>`;
    area.appendChild(row);
    area.appendChild(labels);
    $("#submit-btn").disabled = true;
  }
}

async function submitAnswer() {
  if (!currentQuestion) return;
  const qtype = currentQuestion.qtype || "text";
  let answer = null;
  let answerValue = null;

  if (qtype === "text") {
    const input = $("#answer-input");
    answer = input ? input.value.trim() : "";
    if (!answer) return;
  } else {
    // 複数選択では answerValue が null になるのでラベル側で判定する
    if (!selectedLabel) return;
    answer = selectedLabel;
    answerValue = selectedValue;
  }

  const btn = $("#submit-btn");
  btn.disabled = true;
  btn.textContent = "保存中...";
  try {
    await sbInsert("checkin_responses", {
      question_id: currentQuestion.id,
      question_text: currentQuestion.text,
      qtype,
      answer,
      answer_value: answerValue,
    });
    showToast("記録しました ✓");

    // 通知から開いた場合のクエリを消して、次はランダム出題に戻す
    if (location.search) {
      history.replaceState({}, "", location.pathname);
    }
    currentQuestion = pickRandomQuestion();
    renderQuestion();
    await loadHistory();
  } catch (e) {
    console.error(e);
    showToast("保存に失敗しました");
    btn.disabled = false;
  } finally {
    btn.textContent = "記録する";
  }
}

// ==== 履歴(日別) ====
let historyByDay = {};

function jstDateKey(isoString) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(isoString));
}

function dayLabel(key) {
  const todayKey = jstDateKey(new Date().toISOString());
  const yesterday = new Date(Date.now() - 86400000);
  const yesterdayKey = jstDateKey(yesterday.toISOString());

  const [y, m, d] = key.split("-").map(Number);
  const wd = ["日", "月", "火", "水", "木", "金", "土"][
    new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  ];
  const base = `${m}/${d}(${wd})`;
  if (key === todayKey) return `今日 ${base}`;
  if (key === yesterdayKey) return `昨日 ${base}`;
  return base;
}

async function loadHistory() {
  const rows = await sbGet(
    "checkin_responses?select=question_text,answer,answer_value,qtype,answered_at" +
      "&order=answered_at.desc&limit=300"
  );

  historyByDay = {};
  for (const row of rows) {
    const key = jstDateKey(row.answered_at);
    if (!historyByDay[key]) historyByDay[key] = [];
    historyByDay[key].push(row);
  }

  const days = Object.keys(historyByDay).sort().reverse().slice(0, HISTORY_DAYS);
  const select = $("#day-select");
  const prev = select.value;
  select.innerHTML = "";

  if (days.length === 0) {
    select.style.display = "none";
    renderDay(null);
    return;
  }
  select.style.display = "";
  for (const key of days) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = `${dayLabel(key)}・${historyByDay[key].length}件`;
    select.appendChild(opt);
  }
  select.value = days.includes(prev) ? prev : days[0];
  renderDay(select.value);
}

function renderDay(key) {
  const list = $("#history-list");
  list.innerHTML = "";
  const rows = key ? historyByDay[key] || [] : [];

  if (rows.length === 0) {
    list.innerHTML = '<li class="empty">まだ記録がありません</li>';
    return;
  }

  for (const row of rows) {
    const li = document.createElement("li");
    const time = new Date(row.answered_at).toLocaleTimeString("ja-JP", {
      timeZone: "Asia/Tokyo",
      hour: "2-digit",
      minute: "2-digit",
    });

    let answerHtml;
    if (row.qtype === "scale" && row.answer_value != null) {
      const dots = Array.from({ length: 5 }, (_, i) =>
        `<span class="h-dot${i < row.answer_value ? " on" : ""}"></span>`
      ).join("");
      answerHtml = `<span class="h-scale"><span class="h-bar">${dots}</span>${row.answer_value}/5</span>`;
    } else if (row.qtype === "choice") {
      const chips = row.answer
        .split(CHOICE_SEP)
        .map((s) => `<span class="h-chip">${escapeHtml(s)}</span>`)
        .join("");
      answerHtml = `<div class="h-chips">${chips}</div>`;
    } else {
      answerHtml = escapeHtml(row.answer);
    }

    li.innerHTML =
      `<div class="h-time">${time}</div>` +
      `<div class="h-q">${escapeHtml(row.question_text)}</div>` +
      `<div class="h-a">${answerHtml}</div>`;
    list.appendChild(li);
  }
}

// ==== 通知購読 ====
async function updateSubscribeUI() {
  const banner = $("#install-banner");
  const subBtn = $("#subscribe-btn");
  const statusEl = $("#sub-status");

  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    statusEl.textContent = "この端末では通知を使えません";
    subBtn.style.display = "none";
    return;
  }
  if (!isStandalone()) {
    banner.style.display = "block";
    statusEl.textContent = "ホーム画面に追加すると通知が使えます";
    subBtn.style.display = "none";
    return;
  }
  banner.style.display = "none";
  subBtn.style.display = "";

  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  if (existing) {
    statusEl.textContent = "🔔 通知はON";
    subBtn.textContent = "再登録";
  } else {
    statusEl.textContent = "通知はまだOFFです";
    subBtn.textContent = "通知をON";
  }
}

async function subscribeToPush() {
  const subBtn = $("#subscribe-btn");
  subBtn.disabled = true;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      showToast("通知が許可されませんでした");
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
    const json = sub.toJSON();
    await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?on_conflict=endpoint`, {
      method: "POST",
      headers: sbHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({
        endpoint: json.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
        user_agent: navigator.userAgent,
        last_seen_at: new Date().toISOString(),
      }),
    });
    showToast("通知をONにしました 🔔");
    await updateSubscribeUI();
  } catch (e) {
    console.error(e);
    showToast("通知の登録に失敗しました");
  } finally {
    subBtn.disabled = false;
  }
}

// ==== 初期化 ====
async function init() {
  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("./sw.js");
    } catch (e) {
      console.error("SW registration failed", e);
    }
  }

  $("#submit-btn").addEventListener("click", submitAnswer);
  $("#subscribe-btn").addEventListener("click", subscribeToPush);
  $("#shuffle-btn").addEventListener("click", () => {
    if (location.search) history.replaceState({}, "", location.pathname);
    currentQuestion = pickRandomQuestion();
    renderQuestion();
  });
  $("#day-select").addEventListener("change", (e) => renderDay(e.target.value));

  await loadAllQuestions();
  await setQuestionFromUrlOrRandom();
  renderQuestion();
  await loadHistory();
  await updateSubscribeUI();
}

document.addEventListener("DOMContentLoaded", init);
