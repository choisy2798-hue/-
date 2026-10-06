/* =========================================================
   오늘, 해냈어요 - 푸시 알림 서버
   - 정적 파일(./public) 서빙 + Web Push 구독 관리 + 시간대별 알림 발송
========================================================= */
try { require('dotenv').config(); } catch (e) { /* dotenv 없으면 무시 - 호스팅 환경변수 사용 */ }

const path = require('path');
const fs = require('fs');
const express = require('express');
const webpush = require('web-push');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'subscriptions.json');

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('[오류] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY 환경변수가 설정되지 않았어요. .env.example을 참고해 .env를 만들어 주세요.');
  process.exit(1);
}
webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

/* ---------- 아주 단순한 파일 기반 저장소 ----------
   실사용자가 많아지면(다인용 구조 작업 때) 진짜 데이터베이스로 교체하는 것을 권장합니다.
--------------------------------------------------- */
function ensureDataFile() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]', 'utf-8');
}
function loadSubscriptions() {
  ensureDataFile();
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch (e) {
    return [];
  }
}
function saveSubscriptions(list) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2), 'utf-8');
}

let subscriptions = loadSubscriptions();

/* ---------- 한국 시간 기준 유틸 ---------- */
function seoulNow() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const parts = fmt.formatToParts(new Date());
  const map = {};
  parts.forEach((p) => { map[p.type] = p.value; });
  const dateKey = `${map.year}-${map.month}-${map.day}`;
  const minutes = Number(map.hour) * 60 + Number(map.minute);
  return { dateKey, hh: map.hour, mm: map.minute, minutes };
}
function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

const SLOT_KEYS = ['morning', 'noon', 'evening', 'night'];
const SLOT_LABELS = { morning: '아침', noon: '점심', evening: '저녁', night: '취침전' };

/* ---------- Express 앱 ---------- */
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/subscribe', (req, res) => {
  const { subscription, times, labels, preReminderEnabled, preReminderOffset, repeatAlarmEnabled, name } = req.body || {};
  if (!subscription || !subscription.endpoint || !Array.isArray(times) || times.length !== 4) {
    return res.status(400).json({ ok: false, error: 'invalid payload' });
  }
  const idx = subscriptions.findIndex((s) => s.subscription.endpoint === subscription.endpoint);
  const safeLabels = Array.isArray(labels) && labels.length === 4
    ? labels.map((l, i) => (typeof l === 'string' && l.trim() ? l.slice(0, 12) : SLOT_LABELS[SLOT_KEYS[i]]))
    : SLOT_KEYS.map((k) => SLOT_LABELS[k]);
  const record = {
    subscription,
    times,
    labels: safeLabels,
    preReminderEnabled: !!preReminderEnabled,
    preReminderOffset: Number(preReminderOffset) || 10,
    repeatAlarmEnabled: !!repeatAlarmEnabled,
    name: (name || '어르신').slice(0, 10),
    checkins: idx >= 0 ? subscriptions[idx].checkins || {} : {},
    sentLog: idx >= 0 ? subscriptions[idx].sentLog || {} : {},
    lastSeenDate: idx >= 0 ? subscriptions[idx].lastSeenDate : null,
  };
  if (idx >= 0) subscriptions[idx] = record;
  else subscriptions.push(record);
  saveSubscriptions(subscriptions);
  res.json({ ok: true });
});

app.post('/api/checkin', (req, res) => {
  const { endpoint, slotKey, date } = req.body || {};
  if (!endpoint || !slotKey || !date) return res.status(400).json({ ok: false });
  const rec = subscriptions.find((s) => s.subscription.endpoint === endpoint);
  if (!rec) return res.status(404).json({ ok: false });
  if (!rec.checkins[date]) rec.checkins[date] = [];
  if (!rec.checkins[date].includes(slotKey)) rec.checkins[date].push(slotKey);
  saveSubscriptions(subscriptions);
  res.json({ ok: true });
});

app.post('/api/unsubscribe', (req, res) => {
  const { endpoint } = req.body || {};
  subscriptions = subscriptions.filter((s) => s.subscription.endpoint !== endpoint);
  saveSubscriptions(subscriptions);
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, subscriberCount: subscriptions.length, time: seoulNow() });
});

/* ---------- 알림 발송 ---------- */
function sendPush(rec, title, body, tag) {
  const payload = JSON.stringify({ title, body, tag });
  webpush.sendNotification(rec.subscription, payload).catch((err) => {
    if (err.statusCode === 404 || err.statusCode === 410) {
      subscriptions = subscriptions.filter((s) => s.subscription.endpoint !== rec.subscription.endpoint);
      saveSubscriptions(subscriptions);
    } else {
      console.error('푸시 발송 실패:', err.statusCode, err.body || err.message);
    }
  });
}

function tick() {
  const { dateKey, minutes } = seoulNow();
  let changed = false;

  subscriptions.forEach((rec) => {
    if (rec.lastSeenDate !== dateKey) {
      rec.sentLog = {};
      rec.lastSeenDate = dateKey;
      changed = true;
    }
    const takenToday = rec.checkins[dateKey] || [];

    SLOT_KEYS.forEach((slotKey, i) => {
      const label = (Array.isArray(rec.labels) && rec.labels[i]) || SLOT_LABELS[slotKey];
      const slotMin = timeToMinutes(rec.times[i]);
      const already = takenToday.includes(slotKey);
      if (already) return;

      // 사전 알림
      if (rec.preReminderEnabled) {
        const preKey = `${slotKey}_pre`;
        if (minutes === slotMin - rec.preReminderOffset && !rec.sentLog[preKey]) {
          rec.sentLog[preKey] = true; changed = true;
          sendPush(rec, '오늘, 해냈어요', `${label} 약 먹을 시간이 곧 다가와요. 미리 준비해 주세요.`, `${slotKey}-pre`);
        }
      }
      // 정시 알림
      const onKey = `${slotKey}_on`;
      if (minutes === slotMin && !rec.sentLog[onKey]) {
        rec.sentLog[onKey] = true; changed = true;
        sendPush(rec, '오늘, 해냈어요', `${label} 약 먹을 시간입니다.`, `${slotKey}-on`);
      }
      // 반복 알림 (정시 경과, 5분 간격, 최대 3회)
      if (rec.repeatAlarmEnabled && minutes > slotMin) {
        const elapsed = minutes - slotMin;
        if (elapsed % 5 === 0) {
          const repCount = rec.sentLog[`${slotKey}_repCount`] || 0;
          const repKey = `${slotKey}_rep_${elapsed}`;
          if (repCount < 3 && !rec.sentLog[repKey]) {
            rec.sentLog[repKey] = true;
            rec.sentLog[`${slotKey}_repCount`] = repCount + 1;
            changed = true;
            sendPush(rec, '오늘, 해냈어요', `${label} 약을 아직 못 드셨어요. 지금 챙겨보세요.`, `${slotKey}-rep`);
          }
        }
      }
    });
  });

  if (changed) saveSubscriptions(subscriptions);
}

setInterval(tick, 30 * 1000);

app.listen(PORT, () => {
  console.log(`오늘, 해냈어요 서버가 ${PORT}번 포트에서 실행 중이에요.`);
});
