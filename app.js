/* =========================================================
   오늘, 해냈어요 - 복약 알리미
   (저장 구조: appData = { user, medications, medicationRecords, settings, reasons, meta })
========================================================= */

const STORAGE_KEY = 'onulHaenaesseoyoAppData_v1';
const LEGACY_STORAGE_KEY = 'onulHaenaesseoyoState_v1'; // 이전 버전 데이터 마이그레이션용
const DEFAULT_LABELS = ['아침','점심','저녁','취침전'];

/* ---------- Web Push ---------- */
// 공개키(서버의 개인키와 반드시 짝이 맞아야 함). 서버 .env의 VAPID_PUBLIC_KEY와 동일해야 합니다.
const PUBLIC_VAPID_KEY = 'BPt6GKZaFZUGpYpVjEhHLPwT8r2Sl-6EvN4KmqXs0foB2FG6x9GcWPT1PpRHG2UF5An3W6wnp3QMSuLwjOJxZr4';
let pushSubscription = null;
let pushEnabled = false;

function urlBase64ToUint8Array(base64String){
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g,'+').replace(/_/g,'/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i=0;i<rawData.length;i++) outputArray[i]=rawData.charCodeAt(i);
  return outputArray;
}

async function enablePushNotifications(){
  if(!('serviceWorker' in navigator) || !('PushManager' in window)){
    toast('이 브라우저에서는 푸시 알림을 지원하지 않아요.');
    return false;
  }
  try{
    const perm = await Notification.requestPermission();
    if(perm !== 'granted'){
      toast('알림 권한이 허용되지 않았어요.');
      return false;
    }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if(!sub){
      sub = await reg.pushManager.subscribe({
        userVisibleOnly:true,
        applicationServerKey:urlBase64ToUint8Array(PUBLIC_VAPID_KEY),
      });
    }
    pushSubscription = sub;
    pushEnabled = true;
    await syncPushConfig();
    toast('이 기기로 복약 시간에 푸시 알림을 받을 수 있어요.');
    saveState();
    return true;
  }catch(e){
    toast('푸시 알림 설정에 실패했어요. 잠시 후 다시 시도해주세요.');
    return false;
  }
}

async function disablePushNotifications(){
  try{
    if(pushSubscription){
      await fetch('/api/unsubscribe', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ endpoint: pushSubscription.endpoint }),
      }).catch(()=>{});
      await pushSubscription.unsubscribe();
    }
  }catch(e){ /* ignore */ }
  pushSubscription=null;
  pushEnabled=false;
  saveState();
}

async function syncPushConfig(){
  if(!pushEnabled || !pushSubscription) return;
  try{
    await fetch('/api/subscribe', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        subscription: pushSubscription.toJSON(),
        times: state.times,
        labels: state.slots.map(s=>s.label),
        preReminderEnabled: state.preReminderEnabled,
        preReminderOffset: state.preReminderOffset,
        repeatAlarmEnabled: state.repeatAlarmEnabled,
        name: state.name,
      }),
    });
  }catch(e){ /* 네트워크 오류는 조용히 무시 - 다음 변경 시 재시도됨 */ }
}

async function sendCheckinToServer(slotKey){
  if(!pushEnabled || !pushSubscription) return;
  try{
    await fetch('/api/checkin', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ endpoint: pushSubscription.endpoint, slotKey, date: dateKey(nowDate()) }),
    });
  }catch(e){ /* 무시 */ }
}

async function restorePushSubscriptionIfAny(){
  if(!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try{
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if(sub){
      pushSubscription = sub;
      pushEnabled = true;
      syncPushConfig();
    }
  }catch(e){ /* 무시 */ }
}

/* ---------- Utilities ---------- */
function pad2(n){ return String(n).padStart(2,'0'); }
function nowDate(){ return new Date(); }
function timeToMinutes(t){ const [h,m]=t.split(':').map(Number); return h*60+m; }
function nowMinutes(d){ d=d||new Date(); return d.getHours()*60+d.getMinutes(); }
function mondayIndex(d){ return (d.getDay()+6)%7; }
function fmtDateFull(d){
  const days=['일','월','화','수','목','금','토'];
  return `${d.getFullYear()}년 ${d.getMonth()+1}월 ${d.getDate()}일 (${days[d.getDay()]})`;
}
const DOW=['일','월','화','수','목','금','토'];
function dateKey(d){
  if(typeof d==='string') return d;
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}
function parseDateKey(key){
  const [y,m,dd]=key.split('-').map(Number);
  return new Date(y,m-1,dd);
}

/* ---------- State ---------- */
const state={
  name:'어르신',
  fontSize:16,
  times:['08:00','12:30','18:30','21:30'],
  soundAlert:true,
  familyAlert:false,
  slots:[
    {key:'morning',label:'아침',icon:'🌅',intent:'식사 후 드세요',taken:false},
    {key:'noon',label:'점심',icon:'🌞',intent:'식사 후 드세요',taken:false},
    {key:'evening',label:'저녁',icon:'🌇',intent:'식사 후 드세요',taken:false},
    {key:'night',label:'취침전',icon:'🌙',intent:'주무시기 전에',taken:false},
  ],
  medicationRecords:{},    // { "YYYY-MM-DD": {morning:'taken'|'missed', ...} } - 날짜별 복약 기록 (오늘 포함, 항상 최신 상태로 저장)
  lastActiveDate:null,     // 마지막으로 앱을 사용한 날짜 (롤오버 판단용)
  missedNotified:{},       // { "YYYY-MM-DD_slotKey": true } - 놓침 알림 중복 방지
  consultRequested:false,
  medications:[],          // 사용자가 직접 등록 (데모 데이터 없음)
  slotReasons:{},
  preReminderEnabled:false,
  preReminderOffset:10,
  repeatAlarmEnabled:false,
  alarmedSlots:new Set(),
  repeatCounts:{},
  medIdSeq:1,
  notifLog:[],
};

let currentTab='home';
let checkSelectedSlot=null;
let recordSubview='schedule';
let logMonthCursor=new Date(nowDate().getFullYear(), nowDate().getMonth(), 1);
let logSelectedDate=nowDate();
let logFilter='all';
let healthFilter='전체';
let currentDetail=null;
let storageAvailable=true;

/* ---------- Reason map ---------- */
const REASON_MAP={
  forget_time:{label:'약 먹는 시간을 잊음',tip:'복약 시간 10분 전에 미리 한 번 더 알려드릴게요.',action:'preReminder',actionLabel:'10분 전 미리 알림 켜기'},
  went_out:{label:'외출 중이라 복용하지 못함',tip:'외출하시기 전에 미리 알림을 드릴게요. 나가시기 전 약부터 챙겨보세요.',action:'preReminder',actionLabel:'외출 전 미리 알림 켜기'},
  lost_location:{label:'약을 어디에 뒀는지 모름',tip:'식탁 위나 냉장고 옆처럼 눈에 잘 띄는 곳에 약을 두면 훨씬 쉽게 찾을 수 있어요.',action:null,actionLabel:null},
  missed_alarm:{label:'알림을 확인하지 못함',tip:'놓치면 5분마다 다시 알려드릴게요. 소리도 다시 한 번 들어보시겠어요?',action:'repeatAlarm',actionLabel:'반복 알림 켜기'},
  forgot_need:{label:'복용할 필요성을 잊음',tip:'보호자에게도 함께 알려드리면 옆에서 챙겨드릴 수 있어요.',action:'familyAlert',actionLabel:'보호자 알림 켜기'},
  other:{label:'기타',tip:"어떤 어려움이 있으신지 약사님과 상담해보시는 것도 좋아요. 아래 '약사 상담 요청'을 확인해보세요.",action:null,actionLabel:null},
};
const REASON_ORDER=['forget_time','went_out','lost_location','missed_alarm','forgot_need','other'];
const CHEER_TOASTS=['오늘도 잘 챙기셨어요! 정말 대단해요 🌿','한 걸음씩 건강해지고 계세요 😊','잘하셨어요! 이 마음 그대로 쭉이요 🌱','오늘도 스스로를 잘 챙기셨네요 👏','약속을 지켜주셔서 감사해요 🌳'];

/* ---------- Toast ---------- */
let toastTimer=null;
function toast(msg){
  const el=document.getElementById('toast');
  el.textContent=msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>el.classList.remove('show'),2600);
}

/* ---------- Sound / Voice ---------- */
function playChime(){
  try{
    const ctx=new (window.AudioContext||window.webkitAudioContext)();
    const osc=ctx.createOscillator(); const gain=ctx.createGain();
    osc.type='sine'; osc.frequency.value=1046.5;
    gain.gain.setValueAtTime(0.0001,ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.25,ctx.currentTime+0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001,ctx.currentTime+0.4);
    osc.connect(gain).connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime+0.42);
  }catch(e){ toast('소리 재생에 실패했어요. 기기 소리 설정을 확인해주세요.'); }
}
let koVoice=null;
function pickKoreanVoice(){
  const voices=window.speechSynthesis?window.speechSynthesis.getVoices():[];
  koVoice=voices.find(v=>v.lang&&v.lang.toLowerCase().startsWith('ko'))||null;
}
if(window.speechSynthesis){ pickKoreanVoice(); window.speechSynthesis.onvoiceschanged=pickKoreanVoice; }
function speak(text){
  if(!('speechSynthesis' in window)){ toast('이 기기에서는 음성 안내를 지원하지 않아요.'); return; }
  try{
    if(!koVoice) pickKoreanVoice();
    const u=new SpeechSynthesisUtterance(text);
    u.lang='ko-KR'; if(koVoice) u.voice=koVoice; u.rate=0.95;
    window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
  }catch(e){ toast('음성 재생에 실패했어요.'); }
}

/* ================= LOCAL STORAGE PERSISTENCE =================
   appData = {
     user: { name },
     medications: [...],
     medicationRecords: { "YYYY-MM-DD": { morning:'taken'|'missed', ... } },
     settings: { times, slotLabels, soundAlert, familyAlert,
                 preReminderEnabled, preReminderOffset, repeatAlarmEnabled, fontSize },
     reasons: { slotKey: reasonKey },
     consultRequested: bool,
     meta: { medIdSeq, lastActiveDate, missedNotified, alarmedSlots, repeatCounts, notifLog }
   }
================================================================ */

/* 오늘 하루의 최신 복약 상태 스냅샷 (taken/missed만 기록, 아직 복약 전인 슬롯은 기록하지 않음) */
function currentDaySnapshot(){
  const rec={};
  state.slots.forEach(s=>{
    const st=slotStatusToday(s);
    if(st==='taken') rec[s.key]='taken';
    else if(st==='missed') rec[s.key]='missed';
  });
  return rec;
}

function buildAppData(){
  state.medicationRecords[dateKey(nowDate())]=currentDaySnapshot();
  return {
    version:1,
    user:{ name:state.name },
    medications:state.medications,
    medicationRecords:state.medicationRecords,
    settings:{
      times:state.times,
      slotLabels:state.slots.map(s=>s.label),
      soundAlert:state.soundAlert,
      familyAlert:state.familyAlert,
      preReminderEnabled:state.preReminderEnabled,
      preReminderOffset:state.preReminderOffset,
      repeatAlarmEnabled:state.repeatAlarmEnabled,
      fontSize:state.fontSize,
    },
    reasons:state.slotReasons,
    consultRequested:state.consultRequested,
    meta:{
      medIdSeq:state.medIdSeq,
      lastActiveDate:state.lastActiveDate,
      missedNotified:state.missedNotified,
      alarmedSlots:Array.from(state.alarmedSlots),
      repeatCounts:state.repeatCounts,
      notifLog:state.notifLog.slice(0,50).map(n=>({time:n.time.toISOString(), text:n.text})),
    },
  };
}

function saveState(){
  if(!storageAvailable) return;
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify(buildAppData()));
  }catch(e){ storageAvailable=false; }
}

/* 구버전(onulHaenaesseoyoState_v1)으로 저장된 데이터가 있다면 새 구조로 옮겨온다 */
function migrateLegacyIfNeeded(){
  try{
    const legacyRaw=localStorage.getItem(LEGACY_STORAGE_KEY);
    if(!legacyRaw) return false;
    const old=JSON.parse(legacyRaw);
    if(!old || typeof old!=='object') return false;
    if(typeof old.name==='string') state.name=old.name.slice(0,10)||state.name;
    if(typeof old.fontSize==='number') state.fontSize=old.fontSize;
    if(Array.isArray(old.times)&&old.times.length===4) state.times=old.times;
    if(typeof old.soundAlert==='boolean') state.soundAlert=old.soundAlert;
    if(typeof old.familyAlert==='boolean') state.familyAlert=old.familyAlert;
    if(old.history && typeof old.history==='object') state.medicationRecords=old.history;
    if(old.lastActiveDate) state.lastActiveDate=old.lastActiveDate;
    if(old.missedNotified) state.missedNotified=old.missedNotified;
    if(typeof old.consultRequested==='boolean') state.consultRequested=old.consultRequested;
    if(Array.isArray(old.medications)) state.medications=old.medications;
    if(old.slotReasons) state.slotReasons=old.slotReasons;
    if(typeof old.preReminderEnabled==='boolean') state.preReminderEnabled=old.preReminderEnabled;
    if(typeof old.preReminderOffset==='number') state.preReminderOffset=old.preReminderOffset;
    if(typeof old.repeatAlarmEnabled==='boolean') state.repeatAlarmEnabled=old.repeatAlarmEnabled;
    if(old.repeatCounts) state.repeatCounts=old.repeatCounts;
    if(typeof old.medIdSeq==='number') state.medIdSeq=old.medIdSeq;
    if(Array.isArray(old.notifLog)) state.notifLog=old.notifLog.map(n=>({time:new Date(n.time||Date.now()), text:n.text||''}));
    if(Array.isArray(old.alarmedSlots)) state.alarmedSlots=new Set(old.alarmedSlots);
    if(Array.isArray(old.slotsTaken)){
      old.slotsTaken.forEach(st=>{
        const s=state.slots.find(x=>x.key===st.key);
        if(s) s.taken=!!st.taken;
      });
    }
    saveState(); // 새 구조로 즉시 재저장
    return true;
  }catch(e){
    return false; // 손상된 구버전 데이터는 조용히 무시
  }
}

function loadState(){
  try{
    const raw=localStorage.getItem(STORAGE_KEY);
    if(!raw){ migrateLegacyIfNeeded(); return; }
    const d=JSON.parse(raw);
    if(!d || typeof d!=='object'){ migrateLegacyIfNeeded(); return; }

    if(d.user && typeof d.user.name==='string') state.name=d.user.name.slice(0,10)||state.name;
    if(Array.isArray(d.medications)) state.medications=d.medications;
    if(d.medicationRecords && typeof d.medicationRecords==='object') state.medicationRecords=d.medicationRecords;

    const s=d.settings||{};
    if(Array.isArray(s.times)&&s.times.length===4) state.times=s.times;
    if(Array.isArray(s.slotLabels)&&s.slotLabels.length===4){
      s.slotLabels.forEach((lbl,i)=>{
        if(typeof lbl==='string' && lbl.trim() && state.slots[i]) state.slots[i].label=lbl.slice(0,12);
      });
    }
    if(typeof s.soundAlert==='boolean') state.soundAlert=s.soundAlert;
    if(typeof s.familyAlert==='boolean') state.familyAlert=s.familyAlert;
    if(typeof s.preReminderEnabled==='boolean') state.preReminderEnabled=s.preReminderEnabled;
    if(typeof s.preReminderOffset==='number') state.preReminderOffset=s.preReminderOffset;
    if(typeof s.repeatAlarmEnabled==='boolean') state.repeatAlarmEnabled=s.repeatAlarmEnabled;
    if(typeof s.fontSize==='number') state.fontSize=s.fontSize;

    if(d.reasons && typeof d.reasons==='object') state.slotReasons=d.reasons;
    if(typeof d.consultRequested==='boolean') state.consultRequested=d.consultRequested;

    const meta=d.meta||{};
    if(typeof meta.medIdSeq==='number') state.medIdSeq=meta.medIdSeq;
    if(meta.lastActiveDate) state.lastActiveDate=meta.lastActiveDate;
    if(meta.missedNotified) state.missedNotified=meta.missedNotified;
    if(Array.isArray(meta.alarmedSlots)) state.alarmedSlots=new Set(meta.alarmedSlots);
    if(meta.repeatCounts) state.repeatCounts=meta.repeatCounts;
    if(Array.isArray(meta.notifLog)) state.notifLog=meta.notifLog.map(n=>({time:new Date(n.time||Date.now()), text:n.text||''}));

    // 오늘 날짜의 저장된 기록이 있으면 "복약 완료" 상태를 복원
    const todayKey=dateKey(nowDate());
    const todayRec=state.medicationRecords[todayKey];
    if(todayRec){
      state.slots.forEach(sl=>{ if(todayRec[sl.key]==='taken') sl.taken=true; });
    }
  }catch(e){
    // 저장된 데이터가 손상된 경우: 흰 화면 대신 기본값으로 계속 진행
    console.warn('저장된 데이터를 불러오지 못해 기본값으로 시작해요.', e);
    storageAvailable=true; // localStorage 자체는 쓸 수 있을 수 있으니 저장은 계속 시도
  }
}

/* 날짜가 바뀌면 어제까지의 기록을 확정(미기록 슬롯=놓침)하고 오늘 상태를 초기화 */
function rolloverIfNeeded(){
  const todayKey=dateKey(nowDate());
  if(!state.lastActiveDate){ state.lastActiveDate=todayKey; return; }
  if(state.lastActiveDate===todayKey) return;

  let cursor=parseDateKey(state.lastActiveDate);
  let guard=0;
  while(dateKey(cursor)!==todayKey && guard<400){
    const key=dateKey(cursor);
    const existing=state.medicationRecords[key]||{};
    const finalized={};
    state.slots.forEach(s=>{ finalized[s.key]= existing[s.key]==='taken' ? 'taken' : 'missed'; });
    state.medicationRecords[key]=finalized;
    cursor.setDate(cursor.getDate()+1);
    guard++;
  }
  state.slots.forEach(s=>{ s.taken=false; });
  state.repeatCounts={};
  state.alarmedSlots.clear();
  state.lastActiveDate=todayKey;
  checkSelectedSlot=null;
}

/* ---------- 전체 데이터 삭제 ---------- */
function resetAllData(){
  const confirmed=window.confirm('저장된 모든 복약 기록과 설정을 삭제하시겠습니까?');
  if(!confirmed) return;
  try{ localStorage.removeItem(STORAGE_KEY); }catch(e){}
  try{ localStorage.removeItem(LEGACY_STORAGE_KEY); }catch(e){}

  state.name='어르신';
  state.fontSize=16;
  state.times=['08:00','12:30','18:30','21:30'];
  state.soundAlert=true;
  state.familyAlert=false;
  state.slots.forEach((s,i)=>{ s.taken=false; s.label=DEFAULT_LABELS[i]; });
  state.medicationRecords={};
  state.lastActiveDate=null;
  state.missedNotified={};
  state.consultRequested=false;
  state.medications=[];
  state.slotReasons={};
  state.preReminderEnabled=false;
  state.preReminderOffset=10;
  state.repeatAlarmEnabled=false;
  state.alarmedSlots=new Set();
  state.repeatCounts={};
  state.medIdSeq=1;
  state.notifLog=[];

  checkSelectedSlot=null;
  logMonthCursor=new Date(nowDate().getFullYear(), nowDate().getMonth(), 1);
  logSelectedDate=nowDate();
  logFilter='all';
  healthFilter='전체';

  closeDetail();
  disablePushNotifications();
  toast('모든 데이터를 삭제했어요.');
  switchTab('home');
  renderAll();
}

/* ---------- Derived computations ---------- */
function slotIndex(slot){ return state.slots.indexOf(slot); }
function slotStatusToday(slot){
  const now=nowDate();
  if(slot.taken) return 'taken';
  const t=timeToMinutes(state.times[slotIndex(slot)]);
  if(nowMinutes(now)>t+60) return 'missed';
  return 'pending';
}
function currentActiveSlot(){
  const notTaken=state.slots.filter(s=>!s.taken);
  return notTaken.length ? notTaken[0] : null;
}
function todayDaySummary(){
  const statuses=state.slots.map(slotStatusToday);
  if(statuses.every(s=>s==='taken')) return 'full';
  if(statuses.some(s=>s==='taken')) return 'partial';
  return 'upcoming';
}
function daySlotStatuses(date){
  const key=dateKey(date);
  const todayKey=dateKey(nowDate());
  if(key===todayKey){
    const o={};
    state.slots.forEach(s=>{
      const st=slotStatusToday(s);
      o[s.key]= st==='taken' ? 'taken' : (st==='missed' ? 'missed' : 'pending');
    });
    return o;
  }
  if(key>todayKey) return {morning:'upcoming',noon:'upcoming',evening:'upcoming',night:'upcoming'};
  return state.medicationRecords[key] || {morning:'upcoming',noon:'upcoming',evening:'upcoming',night:'upcoming'};
}
function daySummaryStatus(date){
  const st=daySlotStatuses(date);
  const vals=Object.values(st);
  if(vals.every(v=>v==='upcoming')) return 'upcoming';
  if(vals.every(v=>v==='taken')) return 'full';
  if(vals.some(v=>v==='taken')) return 'partial';
  return 'missed';
}
function getWeekHistory(){
  const idx=mondayIndex(nowDate());
  const today=nowDate();
  const arr=[];
  for(let i=0;i<7;i++){
    const d=new Date(today); d.setDate(today.getDate()+(i-idx));
    arr.push(daySummaryStatus(d));
  }
  return arr;
}
function computeAdherenceRate(){
  const hist=getWeekHistory().filter(s=>s!=='upcoming');
  if(hist.length===0) return 0;
  const sum=hist.reduce((a,s)=>a+(s==='full'?1:s==='partial'?0.5:0),0);
  return Math.round((sum/hist.length)*100);
}
function computePreviousWeekRate(){
  const idx=mondayIndex(nowDate());
  const today=nowDate();
  const mondayThisWeek=new Date(today); mondayThisWeek.setDate(today.getDate()-idx);
  const stats=[];
  for(let i=1;i<=7;i++){
    const d=new Date(mondayThisWeek); d.setDate(mondayThisWeek.getDate()-i);
    const key=dateKey(d);
    const rec=state.medicationRecords[key];
    if(!rec) continue;
    const vals=Object.values(rec);
    if(vals.every(v=>v==='taken')) stats.push(1);
    else if(vals.some(v=>v==='taken')) stats.push(0.5);
    else stats.push(0);
  }
  if(!stats.length) return null;
  return Math.round((stats.reduce((a,b)=>a+b,0)/stats.length)*100);
}
function computeStreak(){
  let streak=0;
  let cursor=new Date(nowDate());
  while(true){
    const status = dateKey(cursor)===dateKey(nowDate()) ? todayDaySummary() : daySummaryStatus(cursor);
    if(status==='full'){ streak++; cursor.setDate(cursor.getDate()-1); }
    else break;
  }
  return streak;
}
function computeMissedHistory(){
  const result={morning:0,noon:0,evening:0,night:0};
  for(let i=0;i<7;i++){
    const d=new Date(); d.setDate(d.getDate()-i);
    const st=daySlotStatuses(d);
    state.slots.forEach(s=>{ if(st[s.key]==='missed') result[s.key]++; });
  }
  return result;
}
function maxMissedInfo(){
  const mh=computeMissedHistory();
  let bestKey=null,bestVal=-1;
  state.slots.forEach(slot=>{ const v=mh[slot.key]; if(v>bestVal){bestVal=v;bestKey=slot.key;} });
  return {key:bestKey,count:bestVal};
}
function slotLabelByKey(key){ const s=state.slots.find(s=>s.key===key); return s?s.label:key; }
function medRemainingDays(med){
  const [y,m,d]=med.prescriptionDate.split('-').map(Number);
  const start=new Date(y,m-1,d);
  const elapsed=Math.round((new Date(nowDate().getFullYear(),nowDate().getMonth(),nowDate().getDate()) - new Date(y,m-1,d))/86400000);
  return med.totalDays-elapsed;
}
function greetingText(){
  const h=nowDate().getHours();
  if(h<11) return '좋은 아침이에요 ☀️';
  if(h<17) return '따뜻한 오후 보내세요 🌤️';
  if(h<20) return '노을 지는 저녁이에요 🌇';
  return '편안한 밤 되세요 🌙';
}
function detectMissedNotifications(){
  const key=dateKey(nowDate());
  state.slots.forEach(slot=>{
    if(slotStatusToday(slot)==='missed'){
      const nk=`${key}_${slot.key}`;
      if(!state.missedNotified[nk]){
        state.missedNotified[nk]=true;
        state.notifLog.unshift({time:nowDate(), text:`${slot.label} 약 복용 시간이 지났어요. 확인해 주세요.`});
      }
    }
  });
}

/* ================= RENDER ROOT ================= */
function renderAll(){
  rolloverIfNeeded();
  detectMissedNotifications();
  renderHome();
  renderCheck();
  if(currentTab==='record') renderRecord();
  if(currentTab==='health') renderHealth();
  if(currentTab==='mypage') renderMypage();
  document.getElementById('bell-dot').classList.toggle('show', state.slots.some(s=>slotStatusToday(s)==='missed'));
  saveState();
}

/* ================= HOME ================= */
function renderHome(){
  document.getElementById('home-hello').textContent='안녕하세요,';
  document.getElementById('home-name').textContent=`${state.name} 어르신`;

  const missed=state.slots.find(s=>slotStatusToday(s)==='missed');
  const active=currentActiveSlot();
  const pill=document.getElementById('status-pill');
  if(missed){
    pill.innerHTML=`<span style="font-size:1.2rem;">🌷</span><span class="txt">아직 ${missed.label} 약을 못 챙기셨어요. 확인해볼까요?</span><span class="chev">›</span>`;
    pill.onclick=()=>{ checkSelectedSlot=missed.key; switchTab('check'); };
  } else if(!active){
    pill.innerHTML=`<span style="font-size:1.2rem;">🎉</span><span class="txt">오늘 복약을 모두 완료하셨어요!</span><span class="chev">›</span>`;
    pill.onclick=()=>switchTab('record');
  } else {
    pill.innerHTML=`<span style="font-size:1.2rem;">${active.icon}</span><span class="txt">지금은 ${active.label} 복약 시간이에요</span><span class="chev">›</span>`;
    pill.onclick=()=>{ checkSelectedSlot=active.key; switchTab('check'); };
  }

  const doneCount=state.slots.filter(s=>s.taken).length;
  const nextSlot=currentActiveSlot();
  document.getElementById('home-arc-card').innerHTML=`
    <div class="arc-card-head">
      <div>
        <p class="arc-card-title">오늘의 복약 현황</p>
        <p class="arc-card-num">${doneCount}<span>/${state.slots.length}회 완료</span></p>
        <p class="arc-card-sub">${nextSlot? `다음 복약 시간: ${state.times[slotIndex(nextSlot)]}` : '오늘 복약을 모두 마쳤어요'}</p>
      </div>
    </div>
    <div class="arc-wrap">${buildArcSVG()}</div>
    ${slotChipRowHTML()}
  `;

  const rate=computeAdherenceRate();
  const streak=computeStreak();
  const depletionCount=state.medications.filter(m=>medRemainingDays(m)<=7).length;
  document.getElementById('home-stats').innerHTML=`
    <div class="stat-mini"><span class="emoji">📈</span><b>${rate}%</b><span>이번 주 복약 이행률</span></div>
    <div class="stat-mini"><span class="emoji">🔥</span><b>${streak}일</b><span>연속 복약 기록</span></div>
    <div class="stat-mini"><span class="emoji">📦</span><b>${depletionCount}건</b><span>처방약 소진 임박</span></div>
  `;

  const info=maxMissedInfo();
  let healthTitle='꾸준한 복약 습관을 이어가고 계세요', healthDesc='지금처럼 규칙적으로 챙겨주시면 충분해요.', healthEmoji='🌿';
  if(info.count>=3){ healthTitle='약사 상담을 받아보시겠어요?'; healthDesc=`최근 ${slotLabelByKey(info.key)} 약을 ${info.count}회 놓치셨어요.`; healthEmoji='💬'; }
  else if(info.count>=2){ healthTitle='복약 패턴을 확인해보세요'; healthDesc=`최근 ${slotLabelByKey(info.key)} 약을 자주 놓치고 계세요.`; healthEmoji='🔍'; }
  document.getElementById('home-health-card').innerHTML=`
    <div class="row-card" id="home-health-row">
      <div class="row-thumb" style="background:var(--primary-tint);">${healthEmoji}</div>
      <div class="row-main"><b>${healthTitle}</b><span>${healthDesc}</span></div>
    </div>
    ${state.medications.length===0 ? `
    <div class="row-card" id="home-add-med-row" style="margin-top:10px;">
      <div class="row-thumb" style="background:var(--amber-tint);">💊</div>
      <div class="row-main"><b>복용 중인 약을 등록해보세요</b><span>마이페이지 &gt; 복약 정보 관리에서 추가할 수 있어요.</span></div>
    </div>` : ''}
  `;
  document.getElementById('home-health-row').onclick=()=>switchTab('health');
  document.getElementById('home-more-health').onclick=()=>switchTab('health');
  const addMedRow=document.getElementById('home-add-med-row');
  if(addMedRow) addMedRow.onclick=()=>{ switchTab('mypage'); openDetail('meds'); };

  document.getElementById('encourage-title').textContent = streak>0 ? `연속 ${streak}일째 잘하고 계세요!` : '오늘도 함께 챙겨봐요!';
}

function slotChipRowHTML(){
  return `<div class="slot-chip-row">` + state.slots.map((s,i)=>{
    const status=slotStatusToday(s);
    const cur = (currentActiveSlot() && currentActiveSlot().key===s.key) ? 'current' : '';
    const takenCls = status==='taken' ? 'taken' : '';
    return `<div class="slot-chip ${cur} ${takenCls}" data-slot="${s.key}">
      <span class="emoji">${s.icon}</span>
      <span class="label">${s.label}</span>
      <span class="time">${state.times[i]}</span>
    </div>`;
  }).join('') + `</div>`;
}

function buildArcSVG(){
  const cx=150, cy=130, r=128;
  const n=state.slots.length;
  const doneRatio=state.slots.filter(s=>s.taken).length/n;
  const toXY=(ang)=>{ const rad=ang*Math.PI/180; return {x:cx+r*Math.cos(rad), y:cy-r*Math.sin(rad)}; };
  const arcPath=(a1,a2)=>{
    const p1=toXY(a1), p2=toXY(a2);
    const large=(a1-a2)>180?1:0;
    return `M ${p1.x} ${p1.y} A ${r} ${r} 0 ${large} 1 ${p2.x} ${p2.y}`;
  };
  const doneEndAngle=180-doneRatio*180;
  let dots='';
  state.slots.forEach((slot,i)=>{
    const angle=180-(180/(n-1))*i;
    const {x,y}=toXY(angle);
    const status=slotStatusToday(slot);
    let fill='#FFFFFF', stroke='#DDE2E6', content=slot.icon;
    if(status==='taken'){ fill='#1DB876'; stroke='#1DB876'; content='✓'; }
    else if(status==='missed'){ fill='#FFEFEC'; stroke='#FF6F5E'; }
    dots+=`<g><circle cx="${x}" cy="${y}" r="17" fill="${fill}" stroke="${stroke}" stroke-width="2.5"></circle>
      <text x="${x}" y="${y+5}" text-anchor="middle" font-size="13" fill="${status==='taken'?'#fff':'#23272B'}">${content}</text></g>`;
  });
  return `<svg class="arc-svg" viewBox="0 0 300 150" xmlns="http://www.w3.org/2000/svg">
    <path d="${arcPath(180,0)}" fill="none" stroke="#FFE8B3" stroke-width="8" stroke-linecap="round"></path>
    ${doneRatio>0?`<path d="${arcPath(180,doneEndAngle)}" fill="none" stroke="#1DB876" stroke-width="8" stroke-linecap="round"></path>`:''}
    ${dots}
  </svg>`;
}

/* ================= 복약체크 ================= */
function renderCheck(){
  if(!checkSelectedSlot){
    const active=currentActiveSlot();
    checkSelectedSlot = active ? active.key : state.slots[state.slots.length-1].key;
  }
  document.getElementById('check-date-label').textContent=fmtDateFull(nowDate());
  document.getElementById('check-slot-row').innerHTML = slotChipRowInnerForCheck();
  document.querySelectorAll('#check-slot-row .slot-chip').forEach(chip=>{
    chip.addEventListener('click', ()=>{ checkSelectedSlot=chip.getAttribute('data-slot'); renderCheck(); });
  });

  const slot=state.slots.find(s=>s.key===checkSelectedSlot);
  const i=slotIndex(slot);
  const status=slotStatusToday(slot);
  const badge = status==='taken' ? `<span class="status-badge done">복약 완료</span>`
    : status==='missed' ? `<span class="status-badge warn">미복약</span>`
    : `<span class="status-badge pending">복약 전</span>`;

  document.getElementById('check-detail-card').innerHTML=`
    <div style="display:flex; align-items:center; gap:12px;">
      <div class="med-check-icon" style="width:48px;height:48px;font-size:1.4rem;">${slot.icon}</div>
      <div style="flex:1;">
        <b style="font-size:1.05rem; display:block;">${slot.label} 복약 시간</b>
        <span style="font-size:0.85rem; color:var(--text-sub);">${state.times[i]} 전후로 복용해주세요</span>
      </div>
      ${badge}
    </div>`;

  const meds=state.medications.filter(m=>m.slots.includes(slot.key));
  const check=status==='taken';
  document.getElementById('check-med-list').innerHTML = meds.length ? meds.map(m=>`
    <div class="med-check-row">
      <div class="med-check-icon">💊</div>
      <div class="med-check-main"><b>${m.name} ${m.dose||''}</b><span>${slot.intent}</span></div>
      <div class="check-circle ${check?'on':''}">${check?'✓':''}</div>
    </div>`).join('') : `<div class="hint-text">이 시간대에 등록된 약이 없어요. 마이페이지에서 약을 등록해보세요.</div>`;

  const btn=document.getElementById('check-confirm-btn');
  if(status==='taken'){ btn.textContent='✅ 복약 완료'; btn.disabled=true; btn.style.background=''; }
  else if(status==='missed'){ btn.textContent='지금 복용하기'; btn.disabled=false; btn.style.background='var(--coral)'; }
  else { btn.textContent='확인 완료'; btn.disabled=false; btn.style.background=''; }
  btn.onclick=()=>toggleSlot(slot.key);

  document.getElementById('check-encourage-slot').innerHTML = status==='taken' ? `
    <div class="card pad-md encourage-card">
      <div class="encourage-icon">🌱</div>
      <div class="encourage-text"><b>복약을 완료했어요!</b><span>이번에도 정말 잘하셨어요 :)</span></div>
    </div>` : '';
}
function slotChipRowInnerForCheck(){
  return state.slots.map((s,i)=>{
    const status=slotStatusToday(s);
    const takenCls=status==='taken'?'taken':'';
    const selCls=checkSelectedSlot===s.key?'selected current':'';
    return `<div class="slot-chip ${takenCls} ${selCls}" data-slot="${s.key}" style="cursor:pointer;">
      <span class="emoji">${s.icon}</span><span class="label">${s.label}</span><span class="time">${state.times[i]}</span>
    </div>`;
  }).join('');
}
function toggleSlot(key){
  const slot=state.slots.find(s=>s.key===key);
  if(!slot||slot.taken) return;
  slot.taken=true;
  toast(CHEER_TOASTS[Math.floor(Math.random()*CHEER_TOASTS.length)]);
  sendCheckinToServer(key);
  renderAll();
}

/* ================= 기록 ================= */
function renderRecord(){
  document.getElementById('rec-seg-schedule').classList.toggle('active', recordSubview==='schedule');
  document.getElementById('rec-seg-log').classList.toggle('active', recordSubview==='log');
  document.getElementById('record-body').innerHTML = recordSubview==='schedule' ? recordScheduleHTML() : recordLogHTML();
  if(recordSubview==='log') bindRecordLogEvents();
  const alertLink=document.getElementById('record-alert-link');
  if(alertLink) alertLink.onclick=()=>openDetail('alert');
}
function recordScheduleHTML(){
  const rate=computeAdherenceRate();
  const hist=getWeekHistory().filter(s=>s!=='upcoming');
  const doneDays=hist.filter(s=>s==='full').length;
  return `
    <div class="card pad-sm" style="display:flex; align-items:center; justify-content:space-between;">
      <b style="font-size:0.98rem;">${fmtDateFull(nowDate())}</b><span>📅</span>
    </div>
    <div class="card">
      <div class="arc-wrap">${buildArcSVG()}</div>
      ${slotChipRowHTML()}
    </div>
    <div class="card pad-md">
      <p class="arc-card-title">이번 주 복약 현황</p>
      <p class="arc-card-num">${hist.length ? `${hist.length}일 중 ${doneDays}일 완료` : '아직 기록이 없어요'} <span style="float:right;">${rate}%</span></p>
      <div class="progress-track"><div class="progress-fill" style="width:${rate}%;"></div></div>
    </div>
    <div class="row-card" id="record-alert-link">
      <div class="row-thumb" style="background:var(--primary-tint);">🔔</div>
      <div class="row-main"><b>복약 알림 설정</b><span>알림 시간과 반복 알림을 관리해요</span></div>
      <span class="chev" style="color:var(--text-faint);">›</span>
    </div>
    <div class="tip-illust-card card" style="padding:0;">
      <div class="tip-illust-body" style="display:flex; gap:12px; align-items:flex-start; padding:16px;">
        <span style="font-size:1.6rem;">💡</span>
        <div>
          <b>복약 시간 안내</b>
          <span>정해진 시간에 복약하는 것이 약의 효과를 높여줍니다.</span>
        </div>
      </div>
    </div>`;
}
function recordLogHTML(){
  const y=logMonthCursor.getFullYear(), m=logMonthCursor.getMonth();
  const daysInMonth=new Date(y,m+1,0).getDate();
  let cells='';
  for(let d=1;d<=daysInMonth;d++){
    const date=new Date(y,m,d);
    const status=daySummaryStatus(date);
    const sel = date.toDateString()===logSelectedDate.toDateString() ? 'selected' : '';
    cells+=`<div class="day-cell ${status} ${sel}" data-date="${dateKey(date)}">
      <div class="dow">${DOW[date.getDay()]}</div><div class="num">${d}</div>
    </div>`;
  }
  const filterChips=['all','morning','noon','evening','night'];
  const filterLabels={all:'전체',morning:'아침',noon:'점심',evening:'저녁',night:'취침전'};
  const chips=filterChips.map(f=>`<button class="chip-filter ${logFilter===f?'active':''}" data-filter="${f}">${filterLabels[f]}</button>`).join('');

  const selStatuses=daySlotStatuses(logSelectedDate);
  const slotRows=state.slots.filter(s=>logFilter==='all'||logFilter===s.key).map((s)=>{
    const st=selStatuses[s.key];
    const label = st==='taken' ? '완료' : st==='upcoming' ? '예정' : st==='pending' ? '복약 전' : '미복약';
    const cls = st==='taken' ? 'done' : st==='missed' ? 'warn' : 'pending';
    return `<div class="med-check-row">
      <div class="med-check-icon">${s.icon}</div>
      <div class="med-check-main"><b>${s.label}</b><span>${state.times[slotIndex(s)]}</span></div>
      <span class="status-badge ${cls}">${label}</span>
    </div>`;
  }).join('');

  let recentRows='';
  for(let i=0;i<7;i++){
    const d=new Date(); d.setDate(d.getDate()-i);
    const st=daySlotStatuses(d);
    const doneCnt=Object.values(st).filter(v=>v==='taken').length;
    recentRows+=`<div class="day-summary-row" data-date="${dateKey(d)}">
      <span class="d">${d.getMonth()+1}월 ${d.getDate()}일 (${DOW[d.getDay()]})</span>
      <span class="ratio">${doneCnt}/4 완료</span>
    </div>`;
  }

  return `
    <div class="chip-filter-row">${chips}</div>
    <div class="month-nav">
      <button id="log-prev-month">‹</button>
      <b>${y}년 ${m+1}월</b>
      <button id="log-next-month">›</button>
    </div>
    <div class="day-strip">${cells}</div>
    <div class="card">
      <div class="day-detail-title">${fmtDateFull(logSelectedDate)}</div>
      ${slotRows}
    </div>
    <div class="section-head"><h2>최근 기록</h2></div>
    <div class="card pad-md">${recentRows}</div>
  `;
}
function bindRecordLogEvents(){
  document.querySelectorAll('.chip-filter').forEach(c=>{
    c.addEventListener('click', ()=>{ logFilter=c.getAttribute('data-filter'); renderRecord(); });
  });
  document.querySelectorAll('.day-cell').forEach(c=>{
    c.addEventListener('click', ()=>{ logSelectedDate=parseDateKey(c.getAttribute('data-date')); renderRecord(); });
  });
  document.querySelectorAll('.day-summary-row').forEach(r=>{
    r.addEventListener('click', ()=>{
      const d=parseDateKey(r.getAttribute('data-date'));
      logSelectedDate=d;
      logMonthCursor=new Date(d.getFullYear(), d.getMonth(), 1);
      renderRecord();
    });
  });
  const prev=document.getElementById('log-prev-month');
  const next=document.getElementById('log-next-month');
  if(prev) prev.addEventListener('click', ()=>{
    logMonthCursor=new Date(logMonthCursor.getFullYear(), logMonthCursor.getMonth()-1, 1);
    renderRecord();
  });
  if(next) next.addEventListener('click', ()=>{
    logMonthCursor=new Date(logMonthCursor.getFullYear(), logMonthCursor.getMonth()+1, 1);
    renderRecord();
  });
}

/* ================= 건강정보 ================= */
function renderHealth(){
  const cats=['전체','건강팁','의료·복지','생활정보'];
  document.getElementById('health-filter-row').innerHTML = cats.map(c=>
    `<button class="chip-filter ${healthFilter===c?'active':''}" data-cat="${c}">${c}</button>`).join('');
  document.querySelectorAll('#health-filter-row .chip-filter').forEach(c=>{
    c.addEventListener('click', ()=>{ healthFilter=c.getAttribute('data-cat'); renderHealth(); });
  });

  if(healthFilter==='전체' || healthFilter==='건강팁'){
    document.getElementById('health-hero').innerHTML=`
      <div class="card tip-illust-card">
        <div class="illust illust-hero" style="background:linear-gradient(135deg,#1DB876,#149A61); color:#fff;">🌤️</div>
        <div class="tip-illust-body">
          <b>건강한 노년을 위한 꾸준한 복약 습관</b>
          <span>매일 같은 시간에 복약하면 약의 효과가 훨씬 좋아져요.</span>
        </div>
      </div>`;
  } else {
    document.getElementById('health-hero').innerHTML='';
  }

  const cards=[];
  const info=maxMissedInfo();

  if(info.count>=2){ cards.push({cat:'의료·복지', html: patternCardHTML(info)}); }
  if(info.count>=3){ cards.push({cat:'의료·복지', html: pharmacyCardHTML(info)}); }
  const depletionHtml = depletionCardHTML();
  if(depletionHtml){ cards.push({cat:'의료·복지', html: depletionHtml}); }

  const staticTips=[
    {cat:'건강팁', emoji:'🥗', title:'식후 30분, 복약 골든타임', desc:'식사 직후 복용하면 위장 부담이 줄어들어요.'},
    {cat:'건강팁', emoji:'💧', title:'물 충분히 마시기', desc:'약 복용 시 물 한 컵을 함께 드세요.'},
    {cat:'생활정보', emoji:'🗓️', title:'복약 달력 활용하기', desc:'매일 체크하는 습관이 순응도를 높여요.'},
    {cat:'생활정보', emoji:'👪', title:'가족과 함께 챙기기', desc:'보호자 알림을 켜면 더 든든해요.'},
  ];
  const filteredTips = staticTips.filter(t=>healthFilter==='전체'||healthFilter===t.cat);
  const filteredCards = cards.filter(c=>healthFilter==='전체'||healthFilter===c.cat);
  let html = filteredCards.map(c=>c.html).join('');
  if(filteredTips.length){
    html += `<div class="grid2">${filteredTips.map(t=>`
      <div class="tip-mini"><span class="emoji">${t.emoji}</span><b>${t.title}</b><span>${t.desc}</span></div>
    `).join('')}</div>`;
  }
  if(!filteredCards.length && !filteredTips.length){
    html = `<div class="card pad-md hint-text" style="margin-top:0;">지금처럼만 꾸준히 챙겨주시면 특별히 안내할 내용이 없어요!</div>`;
  }
  document.getElementById('health-cards').innerHTML = html;

  document.getElementById('health-recommend').innerHTML = `
    <div class="row-card">
      <div class="row-thumb" style="background:var(--amber-tint);">📚</div>
      <div class="row-main"><b>복약 순응도를 높이는 5가지 습관</b><span>작은 습관이 큰 변화를 만들어요.</span></div>
    </div>`;
  document.getElementById('health-more').onclick=()=>toast('추천 콘텐츠를 준비 중이에요.');

  bindHealthCardEvents(info);
}
function patternCardHTML(info){
  const label=slotLabelByKey(info.key);
  const chosen=state.slotReasons[info.key];
  if(!chosen){
    const chips=REASON_ORDER.map(k=>`<button class="chip-filter" data-reason="${k}" style="min-height:44px;">${REASON_MAP[k].label}</button>`).join('');
    return `<div class="card" id="pattern-card">
      <div class="badge-tag">복약 패턴 분석</div>
      <b style="display:block; font-size:1.02rem; margin-bottom:6px;">🔍 최근 7일 동안 ${label} 복약을 ${info.count}회 놓치셨어요.</b>
      <span class="hint-text" style="margin-top:0;">어떤 이유였는지 알려주시면, 맞는 방법을 알려드릴게요.</span>
      <div class="chip-filter-row" style="flex-wrap:wrap; overflow:visible;">${chips}</div>
    </div>`;
  }
  const r=REASON_MAP[chosen];
  const btnHtml=r.action?`<button class="btn-primary" id="pattern-action-btn" style="margin-top:10px;">${r.actionLabel}</button>`:'';
  return `<div class="card" id="pattern-card">
    <div class="badge-tag">복약 패턴 분석</div>
    <b style="display:block; font-size:1.02rem; margin-bottom:6px;">🔍 최근 7일 동안 ${label} 복약을 ${info.count}회 놓치셨어요.</b>
    <span class="hint-text" style="margin-top:0;">선택하신 이유: ${r.label}</span>
    <div class="card pad-sm" style="background:var(--primary-tint); box-shadow:none; margin:10px 0 0;">${r.tip}</div>
    ${btnHtml}
    <div class="hint-text" id="pattern-change-reason" style="text-decoration:underline; cursor:pointer;">다른 이유 선택하기</div>
  </div>`;
}
function pharmacyCardHTML(info){
  const label=slotLabelByKey(info.key);
  const btnHtml=state.consultRequested
    ? `<button class="btn-primary" id="consult-btn" disabled>✅ 상담 신청 완료</button>`
    : `<button class="btn-primary" id="consult-btn">상담 신청</button>`;
  return `<div class="card">
    <div class="badge-tag">⭐⭐⭐⭐⭐ 추천 · 약국 연계</div>
    <b style="display:block; font-size:1.02rem; margin-bottom:6px;">💬 약사 상담을 받아보시겠어요?</b>
    <span class="hint-text" style="margin-top:0;">최근 일주일간 ${label} 약을 ${info.count}회 놓치셨어요. 약사님이 복약 패턴을 보고 더 쉬운 복용 방법을 안내해 드릴 수 있어요.</span>
    ${btnHtml}
  </div>`;
}
function depletionCardHTML(){
  const items=state.medications.map(m=>({m,remain:medRemainingDays(m)})).filter(x=>x.remain<=7);
  if(!items.length) return '';
  const rows=items.map(x=>`<div class="med-check-row"><div class="med-check-icon">💊</div>
    <div class="med-check-main"><b>${x.m.name}</b></div>
    <span class="status-badge ${x.remain<=5?'warn':'pending'}">${x.remain}일 후 소진</span></div>`).join('');
  return `<div class="card">
    <b style="display:block; font-size:1.02rem; margin-bottom:4px;">📦 처방약 소진 예측</b>
    ${rows}
    <span class="hint-text">약이 떨어지기 전에 병원 예약 또는 처방 준비를 해두시면 약이 끊기지 않아요.</span>
  </div>`;
}
function bindHealthCardEvents(info){
  document.querySelectorAll('#health-cards [data-reason]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      state.slotReasons[info.key]=btn.getAttribute('data-reason');
      toast('선택해 주셔서 감사해요. 방법을 알려드릴게요.');
      renderAll();
    });
  });
  const actionBtn=document.getElementById('pattern-action-btn');
  if(actionBtn){
    actionBtn.addEventListener('click', ()=>{
      const chosen=state.slotReasons[info.key];
      const action=REASON_MAP[chosen].action;
      if(action==='preReminder'){ state.preReminderEnabled=true; toast('복약 10분 전 미리 알림을 켰어요.'); }
      else if(action==='repeatAlarm'){ state.repeatAlarmEnabled=true; toast('반복 알림을 켰어요.'); }
      else if(action==='familyAlert'){ state.familyAlert=true; toast('보호자 알림을 켰어요.'); }
      renderAll();
    });
  }
  const changeReason=document.getElementById('pattern-change-reason');
  if(changeReason){ changeReason.addEventListener('click', ()=>{ delete state.slotReasons[info.key]; renderAll(); }); }
  const consultBtn=document.getElementById('consult-btn');
  if(consultBtn && !state.consultRequested){
    consultBtn.addEventListener('click', ()=>{
      state.consultRequested=true;
      toast('연계 약국에 상담 요청을 보냈어요. 약사님이 확인 후 연락드릴게요.');
      renderAll();
    });
  }
}

/* ================= 마이페이지 ================= */
function renderMypage(){
  document.getElementById('profile-card-btn').innerHTML=`
    <div class="profile-avatar">🧓</div>
    <div class="profile-main"><b>${state.name} 어르신</b><div class="link">개인정보 보기 ›</div></div>`;
  document.getElementById('profile-card-btn').onclick=()=>openDetail('profile');

  const rate=computeAdherenceRate();
  const hist=getWeekHistory().filter(s=>s!=='upcoming');
  const doneDays=hist.filter(s=>s==='full').length;
  document.getElementById('mypage-status-card').innerHTML=`
    <p class="arc-card-title">복약 관리 현황</p>
    <p class="arc-card-num">이번 주 ${doneDays}/${hist.length||7} <span>· ${rate}%</span></p>
    <div class="progress-track"><div class="progress-fill" style="width:${rate}%;"></div></div>`;

  const menu=[
    {icon:'🔔',label:'복약 알림 설정',key:'alert'},
    {icon:'💊',label:'복약 정보 관리',key:'meds'},
    {icon:'👪',label:'보호자 연동',key:'caregiver'},
    {icon:'🔤',label:'글자 크기 설정',key:'fontsize'},
    {icon:'ℹ️',label:'앱 정보',key:'appinfo'},
  ];
  document.getElementById('mypage-menu').innerHTML=menu.map(m=>`
    <div class="menu-row" data-detail="${m.key}">
      <span class="mi">${m.icon}</span><span class="mt">${m.label}</span><span class="chev">›</span>
    </div>`).join('');
  document.querySelectorAll('#mypage-menu .menu-row').forEach(r=>{
    r.addEventListener('click', ()=>openDetail(r.getAttribute('data-detail')));
  });

  document.getElementById('mypage-reset-row').onclick=resetAllData;
}

/* ================= DETAIL OVERLAY ================= */
function openDetail(type){
  currentDetail=type;
  const titles={
    alert:'복약 알림 설정', meds:'복약 정보 관리', caregiver:'보호자 연동',
    fontsize:'글자 크기 설정', appinfo:'앱 정보', profile:'개인정보 보기', notifications:'알림',
  };
  document.getElementById('detail-title').textContent=titles[type]||'';
  document.getElementById('detail-body').innerHTML = detailBodyHTML(type);
  bindDetailEvents(type);
  document.getElementById('detail-overlay').classList.add('show');
}
function closeDetail(){
  document.getElementById('detail-overlay').classList.remove('show');
  currentDetail=null;
}
function switchHTML(id, checked){
  return `<label class="switch"><input type="checkbox" id="${id}" ${checked?'checked':''}><span class="track"></span><span class="thumb"></span></label>`;
}
function detailBodyHTML(type){
  if(type==='alert'){
    const pushBtnHtml = pushEnabled
      ? `<button class="btn-outline" id="push-toggle-btn">🔕 이 기기 푸시 알림 끄기</button>`
      : `<button class="btn-primary" id="push-toggle-btn">🔔 이 기기로 푸시 알림 받기</button>`;
    return `
      <div class="card pad-md">
        <p class="arc-card-title" style="margin-bottom:6px;">📲 푸시 알림 (앱을 꺼둬도 울려요)</p>
        <span class="hint-text" style="margin-top:0;">한 번만 켜두면, 앱을 열어두지 않아도 복약 시간에 알림이 와요. 아이폰은 iOS 16.4 이상 + 홈 화면에 추가된 상태에서만 지원돼요.</span>
        ${pushBtnHtml}
        <p class="hint-text" id="push-status-text">${pushEnabled ? '✅ 이 기기는 푸시 알림을 받도록 설정되어 있어요.' : '아직 푸시 알림이 꺼져 있어요. 위 버튼을 눌러 켜주세요.'}</p>
      </div>
      <div class="menu-group" style="margin-top:6px;">
        <div class="toggle-row"><span>🔊 복용 시간에 음성으로 알려드려요 (앱을 보고 있을 때)</span>${switchHTML('set-sound',state.soundAlert)}</div>
      </div>
      <div class="card pad-md">
        <p class="arc-card-title" style="margin-bottom:10px;">복약 알림 이름 · 시간</p>
        ${state.slots.map((s,i)=>`
          <div class="field">
            <label>${s.icon} 알림 이름</label>
            <input type="text" maxlength="12" data-idx="${i}" class="set-label" value="${s.label}" placeholder="예: 아침 혈압약">
          </div>
          <div class="field" style="margin-bottom:18px;">
            <label>${s.icon} 시간</label>
            <input type="time" data-idx="${i}" class="set-time" value="${state.times[i]}">
          </div>
        `).join('')}
        <button class="btn-outline" id="preview-voice-btn">🔊 음성 알림 미리 듣기</button>
      </div>
      <div class="menu-group">
        <div class="toggle-row"><span>⏰ 복약 10분 전 미리 알림</span>${switchHTML('set-pre-reminder',state.preReminderEnabled)}</div>
        <div class="toggle-row"><span>🔁 놓치면 5분마다 다시 알림</span>${switchHTML('set-repeat-alarm',state.repeatAlarmEnabled)}</div>
      </div>
      <p class="hint-text">푸시 알림을 켜두면 앱을 닫아도 알려드리고, 꺼두면 앱을 열어둔 동안에만 소리·음성으로 알려드려요.</p>`;
  }
  if(type==='meds'){
    return `
      <div class="card pad-md" id="med-list">${medListHTML()}</div>
      <div class="card pad-md">
        <p class="arc-card-title" style="margin-bottom:10px;">약 추가하기</p>
        <div class="field"><label>약 이름</label><input type="text" id="new-med-name" placeholder="예: 혈압약"></div>
        <div class="field"><label>복용 시간대 (하나 이상 선택)</label>
          <div class="tag-row" id="new-med-slots">${state.slots.map(s=>`<label class="tag-check"><input type="checkbox" value="${s.key}">${s.icon} ${s.label}</label>`).join('')}</div>
        </div>
        <div class="field"><label>처방받은 날짜</label><input type="date" id="new-med-date"></div>
        <div class="field"><label>총 처방일수</label><input type="number" id="new-med-total" min="1" placeholder="예: 30"></div>
        <button class="btn-primary" id="add-med-btn">+ 약 추가하기</button>
      </div>`;
  }
  if(type==='caregiver'){
    return `
      <div class="menu-group">
        <div class="toggle-row"><span>약을 놓치면 보호자에게도 알려드려요</span>${switchHTML('set-family-alert',state.familyAlert)}</div>
      </div>
      <button class="btn-outline" id="notif-permission-btn">📱 이 기기로 알림 받기</button>
      <p class="hint-text">지금은 이 기기 안에서만 알림이 울려요. 보호자님의 다른 기기로 알림을 보내려면 별도 서버 연동이 필요해요.</p>`;
  }
  if(type==='fontsize'){
    return `
      <div class="card pad-md">
        <p class="arc-card-title" style="margin-bottom:10px;">글자 크기</p>
        <div class="font-seg" id="font-seg">
          <button data-size="16" class="${state.fontSize===16?'active':''}">보통</button>
          <button data-size="19" class="${state.fontSize===19?'active':''}">크게</button>
          <button data-size="23" class="${state.fontSize===23?'active':''}">아주크게</button>
        </div>
      </div>`;
  }
  if(type==='appinfo'){
    return `
      <div class="card pad-md">
        <p style="font-size:1.4rem; margin:0 0 6px;">☀️✅</p>
        <b style="font-size:1.05rem; display:block; margin-bottom:6px;">오늘, 해냈어요</b>
        <span class="hint-text" style="margin-top:0;">버전 1.0.0 · 복약 순응도를 높이는 어르신 맞춤 복약 자가관리 앱입니다. 기록은 이 기기 안에만 저장돼요.</span>
      </div>`;
  }
  if(type==='profile'){
    return `
      <div class="card pad-md">
        <div class="field"><label>내 이름</label><input type="text" id="set-name" maxlength="10" value="${state.name}"></div>
      </div>
      <div class="card pad-md">
        <p class="arc-card-title" style="margin-bottom:10px;">글자 크기</p>
        <div class="font-seg" id="font-seg-2">
          <button data-size="16" class="${state.fontSize===16?'active':''}">보통</button>
          <button data-size="19" class="${state.fontSize===19?'active':''}">크게</button>
          <button data-size="23" class="${state.fontSize===23?'active':''}">아주크게</button>
        </div>
      </div>`;
  }
  if(type==='notifications'){
    if(!state.notifLog.length) return `<div class="card pad-md hint-text" style="margin-top:10px;">아직 알림이 없어요.</div>`;
    return `<div class="card pad-md">${state.notifLog.slice(0,30).map(n=>`
      <div class="notif-row"><b>${n.text}</b><span>${pad2(n.time.getHours())}:${pad2(n.time.getMinutes())}</span></div>
    `).join('')}</div>`;
  }
  return '';
}
function medListHTML(){
  if(!state.medications.length) return `<div class="hint-text" style="margin-top:0;">등록된 약이 없어요. 아래에서 추가해 주세요.</div>`;
  return state.medications.map(m=>{
    const remain=medRemainingDays(m);
    const slotLabels=m.slots.map(k=>slotLabelByKey(k)).join(', ');
    return `<div class="med-manage-row">
      <div class="med-manage-main">
        <b>${m.name}</b>
        <span>하루 ${m.slots.length}회 · ${slotLabels} · 처방일 ${m.prescriptionDate} · 총 ${m.totalDays}일분</span>
        <span class="remain ${remain<=5?'warn':''}">${remain>0?`${remain}일 후 소진`:'이미 소진되었어요'}</span>
      </div>
      <button class="remove-btn" data-med-id="${m.id}">✕</button>
    </div>`;
  }).join('');
}
function bindDetailEvents(type){
  if(type==='alert'){
    const pushBtn=document.getElementById('push-toggle-btn');
    if(pushBtn){
      pushBtn.addEventListener('click', async ()=>{
        if(pushEnabled){ await disablePushNotifications(); toast('푸시 알림을 껐어요.'); }
        else { await enablePushNotifications(); }
        openDetail('alert');
      });
    }
    document.getElementById('set-sound').addEventListener('change', e=>{ state.soundAlert=e.target.checked; toast(state.soundAlert?'음성 알림을 켰어요.':'음성 알림을 껐어요.'); saveState(); });
    document.querySelectorAll('.set-time').forEach(inp=>{
      inp.addEventListener('change', e=>{
        state.times[Number(e.target.getAttribute('data-idx'))]=e.target.value;
        state.alarmedSlots.clear();
        toast('알림 시각을 변경했어요.');
        syncPushConfig();
        renderAll();
      });
    });
    document.querySelectorAll('.set-label').forEach(inp=>{
      inp.addEventListener('change', e=>{
        const idx=Number(e.target.getAttribute('data-idx'));
        const val=e.target.value.trim().slice(0,12);
        state.slots[idx].label = val || DEFAULT_LABELS[idx];
        e.target.value = state.slots[idx].label;
        toast('알림 이름을 변경했어요.');
        syncPushConfig();
        renderAll();
      });
    });
    document.getElementById('preview-voice-btn').addEventListener('click', ()=>{
      speak('약 먹을 시간입니다'); playChime(); toast('음성 안내를 재생했어요.');
    });
    document.getElementById('set-pre-reminder').addEventListener('change', e=>{ state.preReminderEnabled=e.target.checked; syncPushConfig(); saveState(); });
    document.getElementById('set-repeat-alarm').addEventListener('change', e=>{ state.repeatAlarmEnabled=e.target.checked; syncPushConfig(); saveState(); });
  }
  if(type==='meds'){
    document.querySelectorAll('.remove-btn').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        state.medications=state.medications.filter(m=>m.id!==btn.getAttribute('data-med-id'));
        toast('약을 삭제했어요.');
        renderAll();
        openDetail('meds');
      });
    });
    document.getElementById('add-med-btn').addEventListener('click', ()=>{
      const name=document.getElementById('new-med-name').value.trim();
      const checked=Array.from(document.querySelectorAll('#new-med-slots input:checked')).map(i=>i.value);
      const date=document.getElementById('new-med-date').value;
      const total=Number(document.getElementById('new-med-total').value);
      if(!name){ toast('약 이름을 입력해 주세요.'); return; }
      if(!checked.length){ toast('복용 시간대를 하나 이상 선택해 주세요.'); return; }
      if(!date){ toast('처방받은 날짜를 입력해 주세요.'); return; }
      if(!total||total<=0){ toast('총 처방일수를 입력해 주세요.'); return; }
      state.medications.push({id:'m'+(state.medIdSeq++), name, dose:'1정', slots:checked, prescriptionDate:date, totalDays:total});
      toast(`${name}을(를) 추가했어요.`);
      renderAll();
      openDetail('meds');
    });
  }
  if(type==='caregiver'){
    document.getElementById('set-family-alert').addEventListener('change', e=>{ state.familyAlert=e.target.checked; saveState(); });
    document.getElementById('notif-permission-btn').addEventListener('click', ()=>{
      if(!('Notification' in window)){ toast('이 기기에서는 알림 기능을 지원하지 않아요.'); return; }
      Notification.requestPermission().then(perm=>{
        if(perm==='granted'){ new Notification('오늘, 해냈어요', {body:'알림이 잘 설정되었어요!'}); toast('이 기기로 알림을 받을 수 있어요.'); }
        else toast('알림 권한이 허용되지 않았어요.');
      });
    });
  }
  if(type==='fontsize'){
    document.querySelectorAll('#font-seg button').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        state.fontSize=Number(btn.getAttribute('data-size'));
        document.documentElement.style.fontSize=state.fontSize+'px';
        openDetail('fontsize');
        saveState();
      });
    });
  }
  if(type==='profile'){
    document.getElementById('set-name').addEventListener('input', e=>{ state.name=e.target.value.slice(0,10)||'어르신'; syncPushConfig(); renderAll(); });
    document.querySelectorAll('#font-seg-2 button').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        state.fontSize=Number(btn.getAttribute('data-size'));
        document.documentElement.style.fontSize=state.fontSize+'px';
        openDetail('profile');
        saveState();
      });
    });
  }
}

/* ================= NAVIGATION ================= */
function switchTab(tab){
  currentTab=tab;
  document.querySelectorAll('.tab-view').forEach(v=>v.classList.remove('active'));
  document.getElementById('tab-'+tab).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active', b.getAttribute('data-tab')===tab));
  closeDrawer();
  if(tab==='record') renderRecord();
  if(tab==='health') renderHealth();
  if(tab==='mypage') renderMypage();
  window.scrollTo(0,0);
}
document.querySelectorAll('.nav-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>switchTab(btn.getAttribute('data-tab')));
});
document.getElementById('rec-seg-schedule').addEventListener('click', ()=>{ recordSubview='schedule'; renderRecord(); });
document.getElementById('rec-seg-log').addEventListener('click', ()=>{ recordSubview='log'; renderRecord(); });
document.getElementById('detail-back-btn').addEventListener('click', closeDetail);
document.getElementById('mypage-gear-btn').addEventListener('click', ()=>openDetail('appinfo'));
document.getElementById('bell-btn').addEventListener('click', ()=>openDetail('notifications'));

/* ---------- Drawer ---------- */
function openDrawer(){ document.getElementById('drawer').classList.add('show'); document.getElementById('drawer-backdrop').classList.add('show'); }
function closeDrawer(){ document.getElementById('drawer').classList.remove('show'); document.getElementById('drawer-backdrop').classList.remove('show'); }
document.getElementById('menu-btn').addEventListener('click', openDrawer);
document.getElementById('drawer-backdrop').addEventListener('click', closeDrawer);
document.querySelectorAll('.drawer .dlink').forEach(l=>{
  l.addEventListener('click', ()=>switchTab(l.getAttribute('data-tab')));
});

/* ================= ALARM ENGINE ================= */
function alarmTick(){
  const now=nowDate();
  const curMin=nowMinutes(now);
  const hh=pad2(now.getHours()), mm=pad2(now.getMinutes());
  rolloverIfNeeded();
  state.slots.forEach((slot,i)=>{
    const slotMin=timeToMinutes(state.times[i]);
    if(state.preReminderEnabled && !slot.taken && curMin===slotMin-state.preReminderOffset){
      const key=`pre_${slot.key}_${hh}:${mm}`;
      if(!state.alarmedSlots.has(key)){ state.alarmedSlots.add(key); fireAlarm(`${slot.label} 약 먹을 시간이 곧 다가와요. 미리 준비해 주세요.`); }
    }
    if(curMin===slotMin){
      const key=`on_${slot.key}_${hh}:${mm}`;
      if(!state.alarmedSlots.has(key)){ state.alarmedSlots.add(key); fireAlarm('약 먹을 시간입니다'); }
    }
    if(state.repeatAlarmEnabled && !slot.taken && curMin>slotMin){
      const elapsed=curMin-slotMin;
      if(elapsed%5===0){
        const count=state.repeatCounts[slot.key]||0;
        const key=`rep_${slot.key}_${hh}:${mm}`;
        if(count<3 && !state.alarmedSlots.has(key)){
          state.alarmedSlots.add(key); state.repeatCounts[slot.key]=count+1;
          fireAlarm(`${slot.label} 약을 아직 못 드셨어요. 지금 챙겨보세요.`);
        }
      }
    }
  });
  renderAll();
}
function fireAlarm(text){
  if(state.soundAlert){ playChime(); speak(text); }
  toast(text);
  state.notifLog.unshift({time:nowDate(), text});
  if('Notification' in window && Notification.permission==='granted'){
    try{ new Notification('오늘, 해냈어요', {body:text}); }catch(e){}
  }
}

/* ================= INIT ================= */
function init(){
  loadState();
  document.documentElement.style.fontSize=state.fontSize+'px';
  renderAll();
  setInterval(alarmTick, 20000);
  window.addEventListener('beforeunload', saveState);
  document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='hidden') saveState(); else renderAll(); });
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('./sw.js')
      .then(()=>restorePushSubscriptionIfAny())
      .catch(()=>{});
  }
}
init();
