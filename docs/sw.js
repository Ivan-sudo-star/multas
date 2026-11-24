// Service worker: funciona sin conexión y muestra las notificaciones push.
const CACHE = "multas-v37";
const SHELL = ["./", "index.html", "styles.css", "app.js", "firebase-config.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "icons/escudo-128.png", "icons/balon.png", "privacidad.html"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Primero la red (para recibir cambios), y la copia guardada si no hay conexión.
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: "no-cache" }).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match("index.html")))
  );
});

// Notificaciones push (Firebase Cloud Messaging)
try {
  importScripts("firebase-config.js");
  if (self.FIREBASE_CONFIG && !String(self.FIREBASE_CONFIG.apiKey).startsWith("PON_AQUI")) {
    importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js",
                  "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");
    firebase.initializeApp(self.FIREBASE_CONFIG);
    firebase.messaging(); // muestra solo las notificaciones que llegan con la app cerrada
  }
} catch (err) { /* sin push: la app sigue funcionando */ }

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.FCM_MSG && e.notification.data.FCM_MSG.fcmOptions && e.notification.data.FCM_MSG.fcmOptions.link) || "./#historial";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) { if ("focus" in c) { c.navigate(target).catch(() => {}); return c.focus(); } }
    return self.clients.openWindow(target);
  }));
});
