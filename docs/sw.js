// Service worker: funciona sin conexión y muestra las notificaciones push.
const CACHE = "multas-v44";
const SHELL = ["./", "index.html", "styles.css", "app.js", "firebase-config.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "icons/escudo-128.png", "icons/balon.png", "privacidad.html", "i18n.json"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Primero la red (para recibir cambios). Si la red tarda más de 4 s o falla, la copia guardada.
// Solo se guardan respuestas buenas: nunca un error que luego deje la app colgada.
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  const red = fetch(e.request, { cache: "no-cache" }).then(res => {
    if (res && res.ok && res.type === "basic") { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {}); }
    return res;
  });
  const guardada = () => caches.match(e.request, { ignoreSearch: e.request.mode === "navigate" })
    .then(r => r || (e.request.mode === "navigate" ? caches.match("index.html") : undefined));
  e.respondWith(new Promise(resolve => {
    let hecho = false;
    const dar = r => { if (!hecho && r) { hecho = true; resolve(r); } };
    const t = setTimeout(() => guardada().then(dar), 4000);
    red.then(r => { clearTimeout(t); if (r.ok || !hecho) { if (!r.ok) guardada().then(g => dar(g || r)); else dar(r); } })
       .catch(() => { clearTimeout(t); guardada().then(g => { if (g) dar(g); else if (!hecho) { hecho = true; resolve(Response.error()); } }); });
  }));
  e.waitUntil(red.catch(() => {}));
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
