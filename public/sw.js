const CACHE_NAME = 'onul-haenaesseoyo-v24';
const APP_SHELL = [
  './index.html',
  './app.js',
  './manifest.json',
  './icon-192.png?v=2',
  './icon-512.png?v=2',
  './icon-180.png?v=2',
  './icon-maskable-512.png?v=2',
  './favicon-32.png?v=2',
  './favicon-48.png?v=2'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (event.request.url.includes('/api/')) return; // API 요청은 캐시하지 않음
  /* 앱 본체(html/js/json)는 항상 네트워크 우선 → 새 배포가 바로 반영되고, 오프라인일 때만 저장본을 쓴다.
     (예전 app.js와 새 index.html이 섞여 기능이 안 움직이는 문제 방지) */
  const reqUrl = new URL(event.request.url);
  if (reqUrl.origin === self.location.origin &&
      (event.request.mode === 'navigate' || /\.(js|html|json)$/.test(reqUrl.pathname) || reqUrl.pathname.endsWith('/'))) {
    event.respondWith(
      fetch(event.request, { cache: 'no-cache' })
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request).then((c) => c || caches.match('./index.html')))
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => cached);
    })
  );
});

/* ---------- 실제 푸시 알림 수신 ----------
   중요: Service Worker에는 speechSynthesis(음성 API)가 아예 존재하지 않는다
   (브라우저/OS 공통의 기술적 한계이며 iOS만의 제한이 아님).
   그래서 여기서는 음성을 직접 재생하지 않고,
   1) 시스템 알림을 띄우고
   2) 지금 열려 있는 페이지(탭/PWA)가 있으면 그 페이지에 "음성 재생" 메시지를 보내
      (페이지가 살아있는 동안에만 가능 - 보장되지 않는 best-effort)
   3) 알림을 탭해서 앱이 열릴 때는, 열리는 주소에 음성 문구를 실어 보내
      앱이 뜨자마자 확실하게 음성이 재생되도록 한다. */
self.addEventListener('push', (event) => {
  let data = { title: '복약 알리미', body: '복약 시간을 확인해주세요.' };
  try {
    if (event.data) data = event.data.json();
  } catch (e) {
    if (event.data) data.body = event.data.text();
  }

  const dedupeKey = (data.kind && data.slotKey && data.hh && data.mm)
    ? `${data.kind}_${data.slotKey}_${data.hh}:${data.mm}`
    : null;
  const voiceText = data.voiceText || data.body;

  const options = {
    body: data.body,
    icon: './icon-192.png?v=2',
    badge: './icon-192.png?v=2',
    vibrate: [200, 100, 200],
    tag: data.tag || 'onul-haenaesseoyo',
    renotify: true,
    data: { url: './index.html', dedupeKey, voiceText, slotKey: data.slotKey || null },
  };
  // 복용함/건너뜀/나중에 버튼 - 지원하는 브라우저(주로 안드로이드/데스크톱)에서만 보임.
  // iOS Safari는 알림 액션 버튼 자체를 지원하지 않아 버튼 없이 알림만 표시된다(OS 제한, 우회 불가).
  if (data.actions) {
    options.actions = data.actions;
  }

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(data.title, options),
      // 열려 있는 페이지가 있다면(=완전히 종료되지 않은 상태) 즉시 음성 재생을 시도해본다.
      // 화면이 꺼져 있거나 앱이 완전히 종료된 상태라면 열려있는 페이지가 없어 이 메시지는 전달되지 않는다.
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
        list.forEach((c) => c.postMessage({ type: 'voice-reminder', dedupeKey, text: voiceText }));
      }),
    ])
  );
});

/* 서버에 "복용함/건너뜀/나중에" 결과를 직접 전달한다.
   앱을 다시 열지 않아도 서버가 알림 반복을 즉시 멈추도록 하기 위함
   (Service Worker는 페이지의 localStorage에는 접근할 수 없지만, 네트워크 요청은 보낼 수 있다). */
function reportMedActionToServer(action, slotKey) {
  return self.registration.pushManager.getSubscription().then((sub) => {
    if (!sub) return;
    const endpoint = sub.endpoint;
    const today = new Date();
    const dateStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
    if (action === 'later') {
      return fetch('/api/snooze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint, slotKey }),
      }).catch(() => {});
    }
    const status = action === 'skip' ? 'skip' : 'taken';
    return fetch('/api/checkin', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint, slotKey, date: dateStr, status }),
    }).catch(() => {});
  }).catch(() => {});
}

self.addEventListener('notificationclick', (event) => {
  const action = event.action || '';
  const data = event.notification.data || {};
  const dedupeKey = data.dedupeKey || '';
  const voiceText = data.voiceText || '';
  const slotKey = data.slotKey || '';
  event.notification.close();

  // 복용함/건너뜀/나중에 버튼을 눌렀을 때: 서버에도 알리고, 열려있는 앱 화면에도 알린다.
  if (action && slotKey) {
    event.waitUntil(
      Promise.all([
        reportMedActionToServer(action, slotKey),
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
          const existing = clientsArr.find((c) => c.url.includes('index.html'));
          if (existing) {
            existing.postMessage({ type: 'med-action', action, slotKey });
            return existing.focus();
          }
          // 앱이 아예 닫혀 있었다면, 열리는 주소에 액션 정보를 실어 보내 앱이 뜨자마자 반영되게 한다.
          const url = `./index.html?action=${encodeURIComponent(action)}&slot=${encodeURIComponent(slotKey)}`;
          return self.clients.openWindow(url);
        }),
      ])
    );
    return;
  }

  // 버튼 없이 알림 본문을 그냥 탭한 경우: 기존처럼 음성 재생 경로로 연결
  const targetUrl = `./index.html?speak=${encodeURIComponent(voiceText)}&dedupe=${encodeURIComponent(dedupeKey)}`;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
      const existing = clientsArr.find((c) => c.url.includes('index.html'));
      if (existing) {
        existing.postMessage({ type: 'voice-reminder', dedupeKey, text: voiceText });
        return existing.focus();
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
