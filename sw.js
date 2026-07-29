const CACHE_NAME = "checkin-shell-v1";
const SHELL_FILES = ["./", "./index.html", "./app.js", "./manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "じぶんチェックイン", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "じぶんチェックイン";
  const options = {
    body: data.body || "今、どんな気分?",
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    tag: "checkin-question",
    renotify: true,
    data: {
      questionId: data.questionId || null,
      questionText: data.body || "",
      url: "./index.html" + (data.questionId ? `?q=${data.questionId}` : ""),
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "./index.html";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(url);
      }
    })
  );
});
