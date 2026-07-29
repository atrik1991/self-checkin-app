// ==== 設定 ====
const SUPABASE_URL = "https://eabpkpfshikhhpowljan.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVhYnBrcGZzaGlraGhwb3dsamFuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM5MDM1NDksImV4cCI6MjA5OTQ3OTU0OX0.BkmWZf_EVFLZ8UrkftcLnmEl0e3WhppGAI0dKL10TFg";
const VAPID_PUBLIC_KEY =
  "BJAgBlwx6vt5wI7j5RPPrX_zeicMtp0JBWNrli-jQbWbQsf4X6j7cF8woJXlunn331eSOrN3DDAKmvbtpoXfm1U";

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

async function sbInsert(table, body, extraHeaders = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: sbHeaders({ Prefer: "return=representation", ...extraHeaders }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`INSERT ${table} failed: ${res.status} ${await res.text()}`);
  return res.json();
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

let currentQuestion = null; // { id, text }

async function loadCurrentQuestion() {
  const params = new URLSearchParams(location.search);
  const qId = params.get("q");

  if (qId) {
    const rows = await sbGet(`checkin_questions?id=eq.${qId}&select=id,text`);
    if (rows[0]) {
      currentQuestion = { id: rows[0].id, text: rows[0].text };
      return;
    }
  }
  // クエリなし、または見つからない場合はアクティブな質問からランダムに1つ
  const all = await sbGet("checkin_questions?active=eq.true&select=id,text");
  if (all.length > 0) {
    currentQuestion = all[Math.floor(Math.random() * all.length)];
  }
}

function renderQuestion() {
  if (!currentQuestion) {
    $("#question-text").textContent = "質問を読み込めませんでした";
    return;
  }
  $("#question-text").textContent = currentQuestion.text;
}

async function submitAnswer() {
  const answer = $("#answer-input").value.trim();
  if (!answer) return;
  const btn = $("#submit-btn");
  btn.disabled = true;
  btn.textContent = "保存中...";
  try {
    await sbInsert("checkin_responses", {
      question_id: currentQuestion.id,
      question_text: currentQuestion.text,
      answer,
    });
    $("#answer-input").value = "";
    showToast("記録しました");
    await loadHistory();
    await loadCurrentQuestion();
    renderQuestion();
  } catch (e) {
    showToast("保存に失敗しました");
    console.error(e);
  } finally {
    btn.disabled = false;
    btn.textContent = "記録する";
  }
}

async function loadHistory() {
  const rows = await sbGet(
    "checkin_responses?select=question_text,answer,answered_at&order=answered_at.desc&limit=15"
  );
  const list = $("#history-list");
  list.innerHTML = "";
  if (rows.length === 0) {
    list.innerHTML = '<li class="empty">まだ記録がありません</li>';
    return;
  }
  for (const row of rows) {
    const li = document.createElement("li");
    const date = new Date(row.answered_at);
    const dateStr = date.toLocaleString("ja-JP", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    li.innerHTML = `<div class="h-date">${dateStr}</div><div class="h-q">${escapeHtml(
      row.question_text
    )}</div><div class="h-a">${escapeHtml(row.answer)}</div>`;
    list.appendChild(li);
  }
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

// ==== 通知購読 ====
async function updateSubscribeUI() {
  const banner = $("#install-banner");
  const subBtn = $("#subscribe-btn");
  const statusEl = $("#sub-status");

  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    statusEl.textContent = "この端末・ブラウザは通知に対応していません";
    subBtn.style.display = "none";
    return;
  }

  if (!isStandalone()) {
    banner.style.display = "block";
    subBtn.style.display = "none";
    return;
  }
  banner.style.display = "none";
  subBtn.style.display = "inline-block";

  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  if (existing) {
    statusEl.textContent = "通知は有効です";
    subBtn.textContent = "通知を再登録";
  } else {
    statusEl.textContent = "通知はまだ有効になっていません";
    subBtn.textContent = "通知を有効にする";
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
      headers: sbHeaders({
        Prefer: "resolution=merge-duplicates,return=minimal",
      }),
      body: JSON.stringify({
        endpoint: json.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
        user_agent: navigator.userAgent,
        last_seen_at: new Date().toISOString(),
      }),
    });
    showToast("通知を有効にしました");
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

  await loadCurrentQuestion();
  renderQuestion();
  await loadHistory();
  await updateSubscribeUI();

  $("#submit-btn").addEventListener("click", submitAnswer);
  $("#subscribe-btn").addEventListener("click", subscribeToPush);
}

document.addEventListener("DOMContentLoaded", init);
