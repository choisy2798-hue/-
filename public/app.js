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
        activeSlotKeys: activeSlots().map(s=>s.key), // 약이 등록된 시간대만 서버가 알림을 보내도록
        preReminderEnabled: state.preReminderEnabled,
        preReminderOffset: state.preReminderOffset,
        repeatAlarmEnabled: state.repeatAlarmEnabled,
        name: state.name,
      }),
    });
  }catch(e){ /* 네트워크 오류는 조용히 무시 - 다음 변경 시 재시도됨 */ }
}

async function sendCheckinToServer(slotKey, status){
  if(!pushEnabled || !pushSubscription) return;
  try{
    await fetch('/api/checkin', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ endpoint: pushSubscription.endpoint, slotKey, date: dateKey(nowDate()), status: status||'taken' }),
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
  soundAlert:true,       // 차임벨(알림음) ON/OFF
  voiceReminderEnabled:true, // 🔊 음성 복약 알림("약 먹을 시간입니다") ON/OFF - 기본값 ON
  familyAlert:false,
  slots:[
    {key:'morning',label:'아침',icon:'🌅',intent:'식사 후 드세요',taken:false,skipped:false},
    {key:'noon',label:'점심',icon:'🌞',intent:'식사 후 드세요',taken:false,skipped:false},
    {key:'evening',label:'저녁',icon:'🌇',intent:'식사 후 드세요',taken:false,skipped:false},
    {key:'night',label:'취침전',icon:'🌙',intent:'주무시기 전에',taken:false,skipped:false},
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
  medChecks:{},            // { "YYYY-MM-DD": { slotKey: { medId:true } } } - 약별 개별 복용 체크 (기존 기록 구조와 별도)
  sideEffects:[],          // [{id,date,slot,symptom,other,createdAt}] - 약 먹고 불편한 점 기록 (별도 저장)
  manualSeen:false,        // 사용 방법 안내를 이미 보여줬는지
};

let currentTab='home';
let checkSelectedSlot=null;
let editingMedId=null;
let snoozeUntilMin={}; // { slotKey: 그날 안에서의 분(0~1439) } - "나중에 복용" 눌렀을 때 다음 알림 시각 (세션 한정, 저장 안 함)
const AUTO_CLOSE_MINUTES=120; // 복용 예정 시간 이후 2시간이 지나면 자동으로 알림을 끝내고 미복용 처리
const SNOOZE_MINUTES=20;      // "나중에 복용" 선택 시 다시 알리기까지 걸리는 시간
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

/* 오늘 하루의 최신 복약 상태 스냅샷 (taken/missed만 기록, 아직 복약 전인 슬롯·약이 없는 시간대는 기록하지 않음) */
function currentDaySnapshot(){
  const rec={};
  activeSlots().forEach(s=>{
    const st=slotStatusToday(s);
    if(st==='taken') rec[s.key]='taken';
    else if(st==='missed') rec[s.key]='missed';
  });
  return rec;
}

/* 오래된(120일 이전) 약별 체크는 정리해서 저장 용량을 아낀다 */
function pruneMedChecks(){
  const cut=new Date(nowDate()); cut.setDate(cut.getDate()-120);
  const cutKey=dateKey(cut);
  Object.keys(state.medChecks).forEach(k=>{ if(k<cutKey) delete state.medChecks[k]; });
  return state.medChecks;
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
      voiceReminderEnabled:state.voiceReminderEnabled,
      familyAlert:state.familyAlert,
      preReminderEnabled:state.preReminderEnabled,
      preReminderOffset:state.preReminderOffset,
      repeatAlarmEnabled:state.repeatAlarmEnabled,
      fontSize:state.fontSize,
    },
    reasons:state.slotReasons,
    consultRequested:state.consultRequested,
    medChecks:pruneMedChecks(),
    sideEffects:state.sideEffects,
    manualSeen:state.manualSeen,
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
    if(typeof old.voiceReminderEnabled==='boolean') state.voiceReminderEnabled=old.voiceReminderEnabled;
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
    if(typeof s.voiceReminderEnabled==='boolean') state.voiceReminderEnabled=s.voiceReminderEnabled;
    if(typeof s.familyAlert==='boolean') state.familyAlert=s.familyAlert;
    if(typeof s.preReminderEnabled==='boolean') state.preReminderEnabled=s.preReminderEnabled;
    if(typeof s.preReminderOffset==='number') state.preReminderOffset=s.preReminderOffset;
    if(typeof s.repeatAlarmEnabled==='boolean') state.repeatAlarmEnabled=s.repeatAlarmEnabled;
    if(typeof s.fontSize==='number') state.fontSize=s.fontSize;

    if(d.reasons && typeof d.reasons==='object') state.slotReasons=d.reasons;
    if(typeof d.consultRequested==='boolean') state.consultRequested=d.consultRequested;
    if(d.medChecks && typeof d.medChecks==='object') state.medChecks=d.medChecks;
    if(Array.isArray(d.sideEffects)) state.sideEffects=d.sideEffects.filter(x=>x && typeof x==='object' && x.date);
    if(typeof d.manualSeen==='boolean') state.manualSeen=d.manualSeen;

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
      state.slots.forEach(sl=>{
        if(todayRec[sl.key]==='taken') sl.taken=true;
        else if(todayRec[sl.key]==='missed') sl.skipped=true; // 건너뜀/2시간초과로 이미 확정된 상태 복원
      });
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
    activeSlots().forEach(s=>{ finalized[s.key]= existing[s.key]==='taken' ? 'taken' : 'missed'; });
    state.medicationRecords[key]=finalized;
    cursor.setDate(cursor.getDate()+1);
    guard++;
  }
  state.slots.forEach(s=>{ s.taken=false; s.skipped=false; });
  state.repeatCounts={};
  state.alarmedSlots.clear();
  snoozeUntilMin={};
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
  state.voiceReminderEnabled=true;
  state.familyAlert=false;
  state.slots.forEach((s,i)=>{ s.taken=false; s.skipped=false; s.label=DEFAULT_LABELS[i]; });
  snoozeUntilMin={};
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
  state.sideEffects=[];
  state.medChecks={};
  medDraft={};
  state.manualSeen=true; // 삭제 직후 첫 실행 안내가 다시 뜨지 않게

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
/* 실제로 약이 등록된 시간대만 반환 - 첫 화면/복약체크/기록/놓침판정 전부 이 목록 기준으로 동작 */
function activeSlots(){
  return state.slots.filter(s => state.medications.some(m => Array.isArray(m.slots) && m.slots.includes(s.key)));
}
function slotStatusToday(slot){
  if(slot.taken) return 'taken';
  if(slot.skipped) return 'missed'; // 사용자가 "건너뜀"을 직접 선택한 경우 - 즉시 미복용 확정
  const now=nowDate();
  const t=timeToMinutes(state.times[slotIndex(slot)]);
  // 복용 예정 시간으로부터 AUTO_CLOSE_MINUTES(2시간)가 지나도 선택이 없으면 자동으로 미복용 처리
  if(nowMinutes(now)>t+AUTO_CLOSE_MINUTES) return 'missed';
  return 'pending';
}
/* 알림이 떠서 사용자의 선택(복용함/건너뜀/나중에)을 기다리고 있는 상태인지
   - 복용 예정 시간이 지났고(curMin>=t), 아직 결정되지 않았고(pending), 2시간 자동종료 전인 경우 */
function isAwaitingDecision(slot){
  if(slot.taken||slot.skipped) return false;
  const t=timeToMinutes(state.times[slotIndex(slot)]);
  const cur=nowMinutes(nowDate());
  return cur>=t && cur<=t+AUTO_CLOSE_MINUTES;
}
/* 복용 예정 시간이 지났는데(2시간 안) 아직 복용함/건너뜀 선택이 없고, "나중에"로 미뤄두지도 않은 시간대들.
   아침·점심·저녁·취침전 모두 같은 규칙으로 각각 독립 계산한다. */
function dueSlots(){
  const cur=nowMinutes(nowDate());
  return activeSlots().filter(s=>{
    if(!isAwaitingDecision(s)) return false;
    const sn=snoozeUntilMin[s.key];
    return !(sn!==undefined && cur<sn);
  });
}
/* 미복용 알림 카드: 시간대마다 따로 "복용함 / 건너뜀 / 나중에" 버튼을 보여준다.
   앱을 늦게 열었거나 백그라운드였어도 상태 기준으로 항상 표시된다. */
function renderDueAlerts(containerId, excludeKey){
  const el=document.getElementById(containerId);
  if(!el) return;
  const list=dueSlots().filter(s=>s.key!==excludeKey);
  el.innerHTML=list.map(s=>`
    <div class="card pad-md due-alert" data-due="${s.key}" style="border:1.5px solid var(--coral); background:#FFF8F6;">
      <p class="arc-card-title" style="margin:0 0 4px; color:#C4432F;">🔔 ${s.icon} ${escapeHtml(s.label)} 약 드실 시간이 지났어요</p>
      <p class="hint-text" style="margin:0 0 10px;">예정 시간 ${state.times[slotIndex(s)]} · 약을 드셨나요?</p>
      <div style="display:flex; gap:8px;">
        <button class="btn-primary" data-due-act="taken" style="flex:1;">복용함</button>
        <button class="btn-outline" data-due-act="skip" style="flex:1;">건너뜀</button>
        <button class="btn-outline" data-due-act="later" style="flex:1;">나중에</button>
      </div>
    </div>`).join('');
  el.querySelectorAll('.due-alert').forEach(card=>{
    const key=card.getAttribute('data-due');
    card.querySelectorAll('[data-due-act]').forEach(b=>b.addEventListener('click',()=>applyMedAction(b.getAttribute('data-due-act'), key)));
  });
}
function currentActiveSlot(){
  const notTaken=activeSlots().filter(s=>!s.taken);
  return notTaken.length ? notTaken[0] : null;
}
function todayDaySummary(){
  const slots=activeSlots();
  if(slots.length===0) return 'upcoming'; // 등록된 약이 없으면 이행률 계산에서 제외(= 놓침 아님)
  const statuses=slots.map(slotStatusToday);
  if(statuses.every(s=>s==='taken')) return 'full';
  if(statuses.some(s=>s==='taken')) return 'partial';
  return 'upcoming';
}
function daySlotStatuses(date){
  const key=dateKey(date);
  const todayKey=dateKey(nowDate());
  if(key===todayKey){
    const o={};
    activeSlots().forEach(s=>{
      const st=slotStatusToday(s);
      o[s.key]= st==='taken' ? 'taken' : (st==='missed' ? 'missed' : 'pending');
    });
    return o; // 약이 없는 시간대는 아예 포함하지 않음(= 놓침으로 판단되지 않음)
  }
  if(key>todayKey) return {};
  return state.medicationRecords[key] || {};
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
  const slots=activeSlots();
  const result={};
  slots.forEach(s=>{ result[s.key]=0; });
  for(let i=0;i<7;i++){
    const d=new Date(); d.setDate(d.getDate()-i);
    const st=daySlotStatuses(d);
    slots.forEach(s=>{ if(st[s.key]==='missed') result[s.key]++; });
  }
  return result;
}
function maxMissedInfo(){
  const slots=activeSlots();
  if(slots.length===0) return { key:null, count:-1 };
  const mh=computeMissedHistory();
  let bestKey=null,bestVal=-1;
  slots.forEach(slot=>{ const v=mh[slot.key]||0; if(v>bestVal){bestVal=v;bestKey=slot.key;} });
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

  const slots=activeSlots();
  const missed=slots.find(s=>slotStatusToday(s)==='missed');
  const active=currentActiveSlot();
  const pill=document.getElementById('status-pill');
  const md=`${nowDate().getMonth()+1}월 ${nowDate().getDate()}일`;
  const yak=(l)=>/약$/.test(l)?l:l+' 약';
  if(slots.length===0){
    pill.innerHTML=pillInnerHTML('💊',`${md} · 등록된 약이 없어요. 먼저 약을 등록해볼까요?`,'복약 관리로 이동하기 →');
    pill.onclick=()=>{ switchTab('mypage'); openDetail('meds'); };
  } else if(missed){
    pill.innerHTML=pillInnerHTML('🌷',`${md} ${yak(missed.label)}을 아직 못 챙기셨어요`,'복약 체크 화면으로 이동하기 →');
    pill.onclick=()=>{ checkSelectedSlot=missed.key; switchTab('check'); };
  } else if(!active){
    pill.innerHTML=pillInnerHTML('🎉',`${md} 약을 모두 챙기셨어요 🎉`,'이번 주 기록 보러가기 →');
    pill.onclick=()=>switchTab('record');
  } else {
    pill.innerHTML=pillInnerHTML(active.icon,`${md} ${yak(active.label)} 드실 시간이에요`,'복약 체크 화면으로 이동하기 →');
    pill.onclick=()=>{ checkSelectedSlot=active.key; switchTab('check'); };
  }

  renderDueAlerts('home-due-alerts');
  const doneCount=slots.filter(s=>s.taken).length;
  const nextSlot=currentActiveSlot();
  if(slots.length===0){
    document.getElementById('home-arc-card').innerHTML=`
      <div style="text-align:center; padding:10px 4px;">
        <div style="font-size:2.4rem;">💊</div>
        <p style="font-weight:800; margin:10px 0 4px;">등록된 약이 아직 없어요</p>
        <p class="hint-text" style="margin:0 0 14px;">약을 등록하면 그 시간대만 여기에 표시돼요.</p>
        <button class="btn-primary" id="home-arc-add-med-btn">약 등록하러 가기</button>
      </div>`;
    const btn=document.getElementById('home-arc-add-med-btn');
    if(btn) btn.onclick=()=>{ switchTab('mypage'); openDetail('meds'); };
  } else {
    document.getElementById('home-arc-card').innerHTML=`
      <div class="arc-card-head">
        <div>
          <p class="arc-card-title">오늘의 복약 현황</p>
          <p class="arc-card-num">${doneCount}<span>/${slots.length}회 완료</span></p>
          <p class="arc-card-sub">${nextSlot? `다음 복약 시간: ${state.times[slotIndex(nextSlot)]}` : '오늘 복약을 모두 마쳤어요'}</p>
        </div>
      </div>
      <div class="arc-wrap">${buildArcSVG(slots)}</div>
      ${slotChipRowHTML(slots)}
    `;
  }

  const rate=computeAdherenceRate();
  const streak=computeStreak();
  const depletionCount=state.medications.filter(m=>medRemainingDays(m)<=7).length;
  document.getElementById('home-stats').innerHTML=`
    <div class="stat-mini"><span class="emoji">📈</span><b>${rate}%</b><span>이번 주 복약 이행률</span></div>
    <div class="stat-mini"><span class="emoji">🔥</span><b>${streak}일</b><span>연속 복약 기록</span></div>
    <div class="stat-mini"><span class="emoji">📦</span><b>${depletionCount}건</b><span>처방약 소진 임박</span></div>
  `;

  document.getElementById('encourage-title').textContent = streak>0 ? `연속 ${streak}일째 잘하고 계세요!` : '오늘도 함께 챙겨봐요!';
  renderHomeExtras(slots);
}

/* 홈 하단: 약·알람 등록 / 최근 복약 기록 / 불편한 점 기록 */
function renderHomeExtras(slots){
  const reg=document.getElementById('home-register-btn');
  reg.textContent='💊 약·알람 등록하기';
  reg.className='home-big-btn'+(slots.length>0?' soft':'');
  reg.onclick=()=>{ switchTab('mypage'); openDetail('meds'); };

  const card=document.getElementById('home-recent-card');
  let rows='';
  if(slots.length===0){
    rows=`<div class="hint-text" style="margin:0;">약을 등록하면 복약 기록이 여기에 표시돼요.</div>`;
  } else {
    const n=Math.min(5,7);
    for(let i=0;i<n;i++){
      const d=nowDate(); d.setDate(d.getDate()-i);
      const st=daySlotStatuses(d);
      const done=Object.values(st).filter(v=>v==='taken').length;
      const label = i===0 ? '오늘' : `${d.getMonth()+1}월 ${d.getDate()}일`;
      rows+=`<div class="home-recent-row"><b>${label} (${DOW[d.getDay()]})</b><span>완료 ${done}/${slots.length}</span></div>`;
    }
  }
  card.innerHTML=`<p class="arc-card-title" style="margin-bottom:4px;">📋 최근 복약 기록</p>${rows}
    <button class="btn-outline" id="home-all-records-btn" type="button" style="margin-top:12px; min-height:56px; font-size:1.05rem;">전체 기록 보기</button>`;
  document.getElementById('home-all-records-btn').onclick=()=>{ recordSubview='log'; switchTab('record'); };

  document.getElementById('home-sideeffect-btn').onclick=()=>openDetail('sideeffect');
}

/* 홈 화면 상단 상태 카드(status-pill) 내용을 만든다.
   메인 문구 아래에 "~화면으로 이동하기 →" 같은 작은 안내 문구를 붙여서,
   카드를 누르면 어디로 이동하는지 미리 알 수 있게 한다. */
function pillInnerHTML(icon, mainText, captionText){
  return `<span style="font-size:1.2rem;">${icon}</span>
    <span class="txt-wrap">
      <span class="txt">${mainText}</span>
      <span class="pill-caption">${captionText}</span>
    </span>
    <span class="chev">›</span>`;
}

function slotChipRowHTML(slots){
  slots = slots || activeSlots();
  if(slots.length===0) return '';
  return `<div class="slot-chip-row">` + slots.map((s)=>{
    const i=slotIndex(s);
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

function buildArcSVG(slots){
  slots = slots || activeSlots();
  const n=slots.length;
  if(n===0) return '';
  const cx=150, cy=130, r=128;
  const doneRatio=slots.filter(s=>s.taken).length/n;
  const toXY=(ang)=>{ const rad=ang*Math.PI/180; return {x:cx+r*Math.cos(rad), y:cy-r*Math.sin(rad)}; };
  const arcPath=(a1,a2)=>{
    const p1=toXY(a1), p2=toXY(a2);
    const large=(a1-a2)>180?1:0;
    return `M ${p1.x} ${p1.y} A ${r} ${r} 0 ${large} 1 ${p2.x} ${p2.y}`;
  };
  const doneEndAngle=180-doneRatio*180;
  let dots='';
  slots.forEach((slot,i)=>{
    const angle = n===1 ? 90 : 180-(180/(n-1))*i;
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
  const slots=activeSlots();
  const emptyEl=document.getElementById('check-empty-state');
  const mainEl=document.getElementById('check-main-content');

  if(slots.length===0){
    mainEl.style.display='none';
    renderDueAlerts('check-due-alerts');
    emptyEl.style.display='';
    emptyEl.innerHTML=`
      <div class="card" style="text-align:center;">
        <div style="font-size:2.4rem;">💊</div>
        <p style="font-weight:800; margin:10px 0 4px;">등록된 약이 없어요</p>
        <p class="hint-text" style="margin:0 0 14px;">약을 등록하면 그 시간대만 여기서 확인할 수 있어요.</p>
        <button class="btn-primary" id="check-empty-add-btn">약 등록하러 가기</button>
      </div>`;
    document.getElementById('check-empty-add-btn').onclick=()=>{ switchTab('mypage'); openDetail('meds'); };
    document.getElementById('check-date-label').textContent=fmtDateFull(nowDate());
    return;
  }
  mainEl.style.display='';
  emptyEl.style.display='none';
  emptyEl.innerHTML='';

  if(!checkSelectedSlot || !slots.find(s=>s.key===checkSelectedSlot)){
    const active=currentActiveSlot();
    checkSelectedSlot = active ? active.key : slots[slots.length-1].key;
  }
  document.getElementById('check-date-label').textContent=fmtDateFull(nowDate());
  document.getElementById('check-slot-row').innerHTML = slotChipRowInnerForCheck(slots);
  document.querySelectorAll('#check-slot-row .slot-chip').forEach(chip=>{
    chip.addEventListener('click', ()=>{ checkSelectedSlot=chip.getAttribute('data-slot'); renderCheck(); });
  });

  renderDueAlerts('check-due-alerts', checkSelectedSlot);
  const slot=slots.find(s=>s.key===checkSelectedSlot);
  const i=slotIndex(slot);
  const status=slotStatusToday(slot);
  const badge = status==='taken' ? `<span class="status-badge done">복약 완료</span>`
    : status==='missed' ? `<span class="status-badge warn">미복약</span>`
    : (medCheckedCount(slot.key)>0 ? `<span class="status-badge pending">${medCheckedCount(slot.key)}/${slotMeds(slot.key).length} 복용</span>` : `<span class="status-badge pending">복약 전</span>`);

  document.getElementById('check-detail-card').innerHTML=`
    <div style="display:flex; align-items:center; gap:12px;">
      <div class="med-check-icon" style="width:48px;height:48px;font-size:1.4rem;">${slot.icon}</div>
      <div style="flex:1;">
        <b style="font-size:1.05rem; display:block;">${slot.label} 복약 시간</b>
        <span style="font-size:0.85rem; color:var(--text-sub);">${state.times[i]} 전후로 복용해주세요</span>
      </div>
      ${badge}
    </div>`;

  const meds=slotMeds(slot.key);
  const check=status==='taken';
  const editable=slotEditable(slot);
  const draftIds=medDraftIds(slot.key);
  document.getElementById('check-med-list').innerHTML = meds.length ? `
    ${editable ? `<p class="hint-text" style="margin:0 0 6px;">먹은 약을 눌러 체크한 뒤, 아래 버튼을 눌러 주세요.${meds.length>1?` (복용 완료 ${medCheckedCount(slot.key)}/${meds.length})`:''}</p>` : ''}` + meds.map(m=>{
      const done=medCheckedToday(slot.key,m.id);
      const sel=draftIds.includes(m.id);
      const mark = (done||sel) ? '✓' : '';
      const sub = done ? '복용 완료' : slot.intent;
      return `<div class="med-check-row" data-med-row="${m.id}" style="${(editable&&!done)?'cursor:pointer;':''} min-height:64px; ${sel?'background:var(--primary-tint);':''}">
      <div class="med-check-icon">💊</div>
      <div class="med-check-main"><b>${escapeHtml(m.name)} ${m.dose||''}</b><span>${sub}</span></div>
      ${done ? `<button type="button" class="se-del" data-cancel-med="${m.id}" style="min-width:76px;">완료 취소</button>` : `<div class="check-circle ${sel?'on':''}" style="width:40px;height:40px;">${mark}</div>`}
    </div>`;}).join('') : `<div class="hint-text">이 시간대에 등록된 약이 없어요. 설정 > 복약 관리에서 약을 등록해보세요.</div>`;
  document.querySelectorAll('#check-med-list [data-med-row]').forEach(row=>{
    row.addEventListener('click', ()=>toggleMedDraft(slot.key, row.getAttribute('data-med-row')));
  });
  document.querySelectorAll('#check-med-list [data-cancel-med]').forEach(b=>{
    b.addEventListener('click', (e)=>{ e.stopPropagation(); setMedDoneOnDate(dateKey(nowDate()), slot.key, b.getAttribute('data-cancel-med'), false); toast('복용 완료를 취소했어요.'); });
  });

  const btn=document.getElementById('check-confirm-btn');
  const threeWayEl=document.getElementById('check-three-way');

  if(isAwaitingDecision(slot)){
    // 복용 예정 시간이 지났고 아직 결정이 없는 상태(2시간 안) - 3가지 선택지 제공
    btn.style.display='none';
    threeWayEl.style.display='';
    threeWayEl.innerHTML=`
      <p class="hint-text" style="margin:0 0 10px; text-align:center;">${slot.label} 약, 어떻게 하셨나요?${meds.length>1?'<br>일부만 드셨다면 먹은 약만 눌러 체크하고 "복용함"을 눌러 주세요.':''}</p>
      <div style="display:flex; gap:8px;">
        <button class="btn-primary" id="three-taken" style="flex:1;">복용함</button>
        <button class="btn-outline" id="three-skip" style="flex:1;">건너뜀</button>
        <button class="btn-outline" id="three-later" style="flex:1;">나중에</button>
      </div>`;
    document.getElementById('three-taken').onclick=()=>{ if(medDraftIds(slot.key).length) commitSelectedMeds(slot.key); else toggleSlot(slot.key); };
    document.getElementById('three-skip').onclick=()=>skipSlotNow(slot.key);
    document.getElementById('three-later').onclick=()=>snoozeSlotNow(slot.key);
  } else {
    threeWayEl.style.display='none';
    threeWayEl.innerHTML='';
    btn.style.display='';
    btn.className='btn-primary';
    if(status==='taken'){ btn.className='btn-outline'; btn.textContent='복용 완료 취소'; btn.disabled=false; btn.style.background=''; btn.onclick=()=>cancelSlotToday(slot.key); }
    else if(!editable){ btn.textContent='미복약으로 기록됨'; btn.disabled=true; btn.style.background=''; }
    else {
      const n=draftIds.length;
      btn.textContent = n===0 ? '먹은 약을 체크해 주세요' : `선택한 약 ${n}개 복용 완료`;
      btn.disabled = n===0;
      btn.style.background='';
    }
    if(status!=='taken') btn.onclick=()=>commitSelectedMeds(slot.key);
  }

  document.getElementById('check-encourage-slot').innerHTML = status==='taken' ? `
    <div class="card pad-md encourage-card">
      <div class="encourage-icon">🌱</div>
      <div class="encourage-text"><b>복약을 완료했어요!</b><span>이번에도 정말 잘하셨어요 :)</span></div>
    </div>` : '';
}
function slotChipRowInnerForCheck(slots){
  slots = slots || activeSlots();
  return slots.map((s)=>{
    const i=slotIndex(s);
    const status=slotStatusToday(s);
    const takenCls=status==='taken'?'taken':'';
    const selCls=checkSelectedSlot===s.key?'selected current':'';
    return `<div class="slot-chip ${takenCls} ${selCls}" data-slot="${s.key}" style="cursor:pointer;">
      <span class="emoji">${s.icon}</span><span class="label">${s.label}</span><span class="time">${state.times[i]}</span>
    </div>`;
  }).join('');
}
/* ---- 약별 개별 체크 ---- */
function slotMeds(slotKey){ return state.medications.filter(m=>Array.isArray(m.slots)&&m.slots.includes(slotKey)); }
function medCheckedToday(slotKey, medId){
  const slot=state.slots.find(s=>s.key===slotKey);
  if(slot && slot.taken) return true; // 시간대 전체가 완료면 모든 약 완료
  const t=state.medChecks[dateKey(nowDate())];
  return !!(t && t[slotKey] && t[slotKey][medId]);
}
function medCheckedCount(slotKey){ return slotMeds(slotKey).filter(m=>medCheckedToday(slotKey,m.id)).length; }
function setMedChecked(slotKey, medId, on){
  const k=dateKey(nowDate());
  if(!state.medChecks[k]) state.medChecks[k]={};
  if(!state.medChecks[k][slotKey]) state.medChecks[k][slotKey]={};
  if(on) state.medChecks[k][slotKey][medId]=true; else delete state.medChecks[k][slotKey][medId];
}
/* ---- 선택(임시) → 복약 완료 버튼으로 확정 ----
   약을 눌러 "선택"만 해두고(medDraft, 저장 안 함), 버튼을 눌렀을 때 선택한 약만 medChecks에 기록한다.
   선택하지 않은 약은 그대로(미확인) 남고, 나중에 다시 선택해서 확정할 수 있다. */
let medDraft={}; // { slotKey: { medId:true } }  (화면 선택 상태, 세션 한정)
function medDraftIds(slotKey){
  const ids=Object.keys(medDraft[slotKey]||{});
  return slotMeds(slotKey).filter(m=>ids.includes(m.id) && !medCheckedToday(slotKey,m.id)).map(m=>m.id);
}
function slotEditable(slot){
  return !slot.taken; // 시간이 지났거나 건너뛴 시간대도, 완료되기 전까지는 늦게라도 복용 완료 가능
}
/* ---- 날짜별 약 단위 완료/취소 (오늘 + 지난 날짜 공통) ---- */
function checksOn(dk, slotKey){ return ((state.medChecks[dk]||{})[slotKey])||{}; }
function medDoneOnDate(dk, slotKey, medId){
  if(dk===dateKey(nowDate())) return medCheckedToday(slotKey, medId);
  const ch=checksOn(dk,slotKey);
  if(Object.keys(ch).length) return !!ch[medId];
  return ((state.medicationRecords[dk]||{})[slotKey])==='taken'; // 약별 기록이 없던 예전 기록 = 그 시간대 전체 복용
}
/* 약 하나의 복용 완료(on=true) / 완료 취소(on=false). 다른 약·다른 시간대·다른 날짜는 건드리지 않는다.
   같은 상태로 다시 호출해도 결과가 같다(중복 기록 없음). */
function setMedDoneOnDate(dk, slotKey, medId, on){
  const meds=slotMeds(slotKey);
  if(!meds.some(m=>m.id===medId)) return;
  const isToday = dk===dateKey(nowDate());
  if(!state.medChecks[dk]) state.medChecks[dk]={};
  let ch=state.medChecks[dk][slotKey];
  if(!ch){
    ch={};
    // 약별 기록이 없던 "시간대 전체 완료" 기록은 약별로 풀어서 저장
    const wasTaken = isToday ? (state.slots.find(x=>x.key===slotKey)||{}).taken : ((state.medicationRecords[dk]||{})[slotKey]==='taken');
    if(wasTaken) meds.forEach(m=>{ ch[m.id]=true; });
    state.medChecks[dk][slotKey]=ch;
  } else if(isToday){
    const sl=state.slots.find(x=>x.key===slotKey);
    if(sl && sl.taken) meds.forEach(m=>{ ch[m.id]=true; });
  }
  if(on) ch[medId]=true; else delete ch[medId];
  const all = meds.every(m=>ch[m.id]);
  if(isToday){
    const sl=state.slots.find(x=>x.key===slotKey);
    if(medDraft[slotKey]) delete medDraft[slotKey][medId];
    if(all){ sl.taken=true; sl.skipped=false; delete snoozeUntilMin[slotKey]; }
    else { sl.taken=false; }
    saveState(); renderAll();
  } else {
    if(!state.medicationRecords[dk]) state.medicationRecords[dk]={};
    state.medicationRecords[dk][slotKey] = all ? 'taken' : 'missed';
    saveState();
    renderAll();
    if(currentTab==='record') renderRecord();
  }
}
/* 오늘 한 시간대 전체 완료 취소 */
function cancelSlotToday(slotKey){
  const slot=state.slots.find(x=>x.key===slotKey);
  if(!slot || !slot.taken) return;
  const tk=dateKey(nowDate());
  if(!state.medChecks[tk]) state.medChecks[tk]={};
  state.medChecks[tk][slotKey]={};
  medDraft[slotKey]={};
  slot.taken=false;
  toast(`${slot.label} 복용 완료를 취소했어요.`);
  saveState(); renderAll();
}
function toggleMedDraft(slotKey, medId){
  const slot=state.slots.find(s=>s.key===slotKey);
  if(!slot || !slotEditable(slot) || medCheckedToday(slotKey,medId)) return;
  if(!medDraft[slotKey]) medDraft[slotKey]={};
  if(medDraft[slotKey][medId]) delete medDraft[slotKey][medId]; else medDraft[slotKey][medId]=true;
  renderCheck();
}
/* 선택한 약만 복용 완료로 기록. 그 시간대 약이 전부 확정되면 시간대가 "복약 완료"가 된다. */
function commitSelectedMeds(slotKey){
  const slot=state.slots.find(s=>s.key===slotKey);
  if(!slot || slot.taken) return;
  const ids=medDraftIds(slotKey);
  if(!ids.length) return;
  ids.forEach(id=>setMedChecked(slotKey,id,true));
  medDraft[slotKey]={};
  const meds=slotMeds(slotKey);
  if(meds.every(m=>medCheckedToday(slotKey,m.id))){ toggleSlot(slotKey); return; }
  toast(`선택한 약 ${ids.length}개를 복용 완료로 기록했어요. 남은 약은 나중에 체크해 주세요.`);
  saveState();
  renderAll();
}
function toggleSlot(key){
  const slot=state.slots.find(s=>s.key===key);
  if(!slot||slot.taken) return;
  slot.taken=true;
  slot.skipped=false;
  slotMeds(key).forEach(m=>setMedChecked(key,m.id,true)); // "복용함/확인 완료"는 이 시간대 약 전체 체크
  delete snoozeUntilMin[key];
  closeReminderNotification(key);
  toast(CHEER_TOASTS[Math.floor(Math.random()*CHEER_TOASTS.length)]);
  sendCheckinToServer(key,'taken');
  renderAll();
}
/* "건너뜀" - 해당 시간대 약을 미복용으로 즉시 확정하고 알림을 끝낸다 */
function skipSlotNow(key){
  const slot=state.slots.find(s=>s.key===key);
  if(!slot||slot.taken||slot.skipped) return;
  slot.skipped=true;
  delete snoozeUntilMin[key];
  closeReminderNotification(key);
  toast(`${slot.label} 약을 미복용으로 기록했어요.`);
  sendCheckinToServer(key,'skip');
  renderAll();
}
/* "나중에 복용" - SNOOZE_MINUTES 뒤에 한 번만 다시 알려주고, 2시간 자동종료 범위를 넘지 않는다 */
function snoozeSlotNow(key){
  const slot=state.slots.find(s=>s.key===key);
  if(!slot||slot.taken||slot.skipped) return;
  const t=timeToMinutes(state.times[slotIndex(slot)]);
  const target=Math.min(nowMinutes(nowDate())+SNOOZE_MINUTES, t+AUTO_CLOSE_MINUTES-1);
  snoozeUntilMin[key]=target;
  closeReminderNotification(key);
  toast(`${SNOOZE_MINUTES}분 후 다시 알려드릴게요.`);
  renderAll();
}
function closeReminderNotification(slotKey){
  if('serviceWorker' in navigator && navigator.serviceWorker.ready){
    navigator.serviceWorker.ready.then(reg=>{
      reg.getNotifications({ tag: `reminder-${slotKey}` }).then(list=> list.forEach(n=>n.close()));
    }).catch(()=>{});
  }
}

/* ================= 기록 ================= */
function renderRecord(){
  document.getElementById('rec-seg-schedule').classList.toggle('active', recordSubview==='schedule');
  document.getElementById('rec-seg-log').classList.toggle('active', recordSubview==='log');
  document.getElementById('record-body').innerHTML = recordSubview==='schedule' ? recordScheduleHTML() : recordLogHTML();
  if(recordSubview==='log') bindRecordLogEvents();
}
function recordScheduleHTML(){
  const slots=activeSlots();
  const rate=computeAdherenceRate();
  const hist=getWeekHistory().filter(s=>s!=='upcoming');
  const doneDays=hist.filter(s=>s==='full').length;
  const arcCardInner = slots.length===0
    ? `<div style="text-align:center; padding:10px 4px;">
         <div style="font-size:2rem;">💊</div>
         <p class="hint-text" style="margin:8px 0 0;">등록된 약이 없어서 아직 보여드릴 일정이 없어요.</p>
       </div>`
    : `<div class="arc-wrap">${buildArcSVG(slots)}</div>${slotChipRowHTML(slots)}`;
  return `
    <div class="card pad-sm" style="display:flex; align-items:center; justify-content:space-between;">
      <b style="font-size:0.98rem;">${fmtDateFull(nowDate())}</b><span>📅</span>
    </div>
    <div class="card">
      ${arcCardInner}
    </div>
    <div class="card pad-md">
      <p class="arc-card-title">이번 주 복약 현황</p>
      <p class="arc-card-num">${hist.length ? `${hist.length}일 중 ${doneDays}일 완료` : '아직 기록이 없어요'} <span style="float:right;">${rate}%</span></p>
      <div class="progress-track"><div class="progress-fill" style="width:${rate}%;"></div></div>
    </div>`;
}
/* 실제 요일 격자에 맞춘 월간 달력 (일~토 순서, 다른 달 날짜는 빈 칸으로만 패딩) */
function recordLogHTML(){
  const slots=activeSlots();
  const y=logMonthCursor.getFullYear(), m=logMonthCursor.getMonth();
  const firstDay=new Date(y,m,1);
  const daysInMonth=new Date(y,m+1,0).getDate();
  const leadingBlanks=firstDay.getDay(); // 0=일요일 ~ 6=토요일, 그대로 사용(일요일 시작)
  const todayKeyStr=dateKey(nowDate());
  const selectedKeyStr=dateKey(logSelectedDate);

  let cells='';
  for(let i=0;i<leadingBlanks;i++){ cells+=`<div class="cal-cell empty"></div>`; }
  for(let d=1; d<=daysInMonth; d++){
    const date=new Date(y,m,d);
    const kStr=dateKey(date);
    const status=daySummaryStatus(date);
    const recCount=Object.keys(daySlotStatuses(date)).length;
    const dotCount=Math.min(recCount,4);
    const dots = dotCount>0 ? `<div class="dots">${'<i></i>'.repeat(dotCount)}</div>` : '';
    const cls=[status, kStr===todayKeyStr?'today':'', kStr===selectedKeyStr?'selected':''].filter(Boolean).join(' ');
    cells+=`<div class="cal-cell ${cls}" data-date="${kStr}"><span class="num">${d}</span>${dots}</div>`;
  }

  const filterSlots=[{key:'all',label:'전체',icon:''}].concat(slots.map(s=>({key:s.key,label:s.label,icon:s.icon})));
  const chips=filterSlots.map(f=>`<button class="chip-filter ${logFilter===f.key?'active':''}" data-filter="${f.key}">${f.icon?f.icon+' ':''}${f.label}</button>`).join('');

  const selStatuses=daySlotStatuses(logSelectedDate);
  const isFutureSel = selectedKeyStr>todayKeyStr;
  const isTodaySel = selectedKeyStr===todayKeyStr;
  const rowSlots=slots.filter(s=>logFilter==='all'||logFilter===s.key);
  const slotRows = rowSlots.length ? rowSlots.map((s)=>{
    const st=selStatuses[s.key];
    const label = st==='taken' ? '완료' : st==='missed' ? '미복약' : (isFutureSel ? '예정' : (isTodaySel ? '복약 전' : '기록 없음'));
    const cls = st==='taken' ? 'done' : st==='missed' ? 'warn' : 'pending';
    return `<div class="med-check-row" style="flex-wrap:wrap;">
      <div class="med-check-icon">${s.icon}</div>
      <div class="med-check-main"><b>${s.label}</b><span>${state.times[slotIndex(s)]}</span></div>
      <span class="status-badge ${cls}">${label}</span>
      ${perMedRowsHTML(s, selectedKeyStr, st, isFutureSel)}
    </div>`;
  }).join('') : `<div class="hint-text" style="margin:0;">이 날짜에는 표시할 복약 기록이 없어요.</div>`;

  return `
    <div class="chip-filter-row">${chips}</div>
    <div class="month-nav">
      <button id="log-prev-month">‹</button>
      <b>${y}년 ${m+1}월</b>
      <button id="log-next-month">›</button>
    </div>
    <div style="text-align:right; margin:-6px 2px 8px;">
      <button class="month-nav-today" id="log-today-btn">오늘</button>
    </div>
    <div class="card pad-md">
      <div class="cal-dow-row"><span>일</span><span>월</span><span>화</span><span>수</span><span>목</span><span>금</span><span>토</span></div>
      <div class="cal-grid">${cells}</div>
      ${legendHTML()}
    </div>
    <div class="card">
      <div class="day-detail-title">${fmtDateFull(logSelectedDate)}</div>
      ${slotRows}
      ${sideEffectDayHTML(selectedKeyStr)}
    </div>
  `;
}
/* 날짜 상세에서 시간대 아래에 약별 복용 상태를 보여준다 (약이 2개 이상이거나 일부만 체크된 경우) */
function perMedRowsHTML(slot, key, slotSt, isFuture){
  if(isFuture) return '';
  const meds=slotMeds(slot.key);
  if(!meds.length) return '';
  const anyDone=meds.some(m=>medDoneOnDate(key,slot.key,m.id));
  return `<div style="width:100%; padding:2px 0 4px 0; font-size:0.95rem;">`+meds.map(m=>{
    const done=medDoneOnDate(key,slot.key,m.id);
    const lbl = done ? '✓ 복용' : (anyDone ? '미확인' : (slotSt==='missed' ? '미복용' : (slotSt==='pending' ? '복약 전' : '기록 없음')));
    const col = done ? 'var(--primary-deep)' : ((slotSt==='missed'&&!anyDone) ? '#C4432F' : 'var(--text-sub)');
    return `<div style="display:flex; align-items:center; gap:8px; padding:6px 0; border-top:1px dashed var(--line);">
      <span style="flex:1; min-width:0; overflow-wrap:anywhere;">💊 ${escapeHtml(m.name)}</span>
      <b style="color:${col};">${lbl}</b>
      <button type="button" class="se-del" style="${done?'':'color:var(--primary-deep);'} min-width:84px;" data-rec-toggle="${done?'cancel':'done'}" data-rec-date="${key}" data-rec-slot="${slot.key}" data-rec-med="${m.id}">${done?'완료 취소':'복용 완료'}</button>
    </div>`;
  }).join('')+`</div>`;
}
function legendHTML(){
  return `<div class="legend">
    <span><i style="background:var(--primary);"></i>완료</span>
    <span><i style="background:#8FC4EA;"></i>일부</span>
    <span><i style="background:var(--coral);"></i>놓침</span>
    <span><i style="background:#D9DDE1;"></i>예정/기록없음</span>
  </div>`;
}
function bindRecordLogEvents(){
  document.querySelectorAll('#record-body [data-rec-toggle]').forEach(b=>b.addEventListener('click',()=>{
    const on=b.getAttribute('data-rec-toggle')==='done';
    setMedDoneOnDate(b.getAttribute('data-rec-date'), b.getAttribute('data-rec-slot'), b.getAttribute('data-rec-med'), on);
    toast(on?'복용 완료로 기록했어요.':'복용 완료를 취소했어요.');
  }));
  document.querySelectorAll('#record-body [data-se-del]').forEach(b=>b.addEventListener('click',()=>deleteSideEffect(b.getAttribute('data-se-del'))));
  document.querySelectorAll('.chip-filter').forEach(c=>{
    c.addEventListener('click', ()=>{ logFilter=c.getAttribute('data-filter'); renderRecord(); });
  });
  document.querySelectorAll('.cal-cell:not(.empty)').forEach(c=>{
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
  const todayBtn=document.getElementById('log-today-btn');
  if(prev) prev.addEventListener('click', ()=>{
    logMonthCursor=new Date(logMonthCursor.getFullYear(), logMonthCursor.getMonth()-1, 1);
    renderRecord();
  });
  if(next) next.addEventListener('click', ()=>{
    logMonthCursor=new Date(logMonthCursor.getFullYear(), logMonthCursor.getMonth()+1, 1);
    renderRecord();
  });
  if(todayBtn) todayBtn.addEventListener('click', ()=>{
    logSelectedDate=nowDate();
    logMonthCursor=new Date(nowDate().getFullYear(), nowDate().getMonth(), 1);
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

  const showHabits = healthFilter==='전체' || healthFilter==='건강팁';
  document.getElementById('health-recommend-head').style.display = showHabits ? '' : 'none';
  document.getElementById('health-recommend').innerHTML = showHabits ? habitsCardHTML() : '';

  bindHealthCardEvents(info);
}
/* 복약 순응도 높이는 5가지 습관 */
function habitsCardHTML(){
  const habits=[
    {e:'⏰',t:'매일 정해진 시간에 드세요',d:'밥 먹는 시간처럼 매일 같은 때에 드시면 잊지 않아요.'},
    {e:'📱',t:'알림을 켜두세요',d:'휴대전화 알림이나 복약 알림 앱이 시간을 알려드려요.'},
    {e:'✅',t:'먹었는지 기록하고 확인하세요',d:'먹고 나서 바로 체크하면 먹었는지 헷갈리지 않아요.'},
    {e:'🏠',t:'약은 정해진 방법대로 보관하세요',d:'약 설명서대로 보관하세요. 햇빛과 습기를 피해 서늘한 곳에 두면 좋아요.'},
    {e:'👩‍⚕️',t:'힘들거나 불편하면 상담하세요',d:'약 먹기가 어렵거나 부작용이 있으면 혼자 끊지 말고 의사·약사님께 물어보세요.'},
  ];
  return `<div class="card pad-md" id="habits-card">
    <p class="hint-text" style="margin:0 0 8px; font-size:1rem; line-height:1.6;"><b>복약 순응도</b>란, 처방받은 약을 정해진 시간과 방법에 맞게 꾸준히 드시는 것이에요.</p>
    ${habits.map((h,i)=>`<div style="display:flex; gap:12px; align-items:flex-start; padding:14px 0; border-top:1px solid var(--line);">
      <div style="font-size:1.8rem; line-height:1;">${h.e}</div>
      <div style="flex:1; min-width:0;"><b style="display:block; font-size:1.08rem; margin-bottom:4px;">${i+1}. ${h.t}</b><span style="font-size:1rem; line-height:1.55; color:var(--text-sub);">${h.d}</span></div>
    </div>`).join('')}
  </div>`;
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

/* ================= 불편한 점(부작용) 기록 · 사용 방법 ================= */
const SYMPTOMS=['어지러움','속쓰림','메스꺼움','졸림','두통','가려움·발진','기타'];
let sideEffectDraft={symptom:null, slot:null};
const MANUAL_CARDS=[
  {icon:'💊',title:'약 등록하기',desc:'홈 아래 "약·알람 등록하기"를 눌러 약 이름과 먹는 시간을 골라 주세요.'},
  {icon:'✅',title:'약 먹었다고 체크하기',desc:'복약체크에서 "복용함", "건너뜀", "나중에" 중 하나를 눌러 주세요.'},
  {icon:'🔔',title:'알림 받기',desc:'설정 > 복약 관리에서 푸시 알림을 켜고, 브라우저 메뉴에서 "홈 화면에 추가"를 해 주세요.'},
  {icon:'🗂️',title:'기록 보기',desc:'아래 "기록"에서 달력의 날짜를 누르면 그날 약을 드셨는지 볼 수 있어요.'},
  {icon:'😣',title:'불편한 점 기록하기',desc:'약 먹고 어지러우면 홈의 "불편한 점" 버튼을 눌러 증상을 골라 남기세요.'},
  {icon:'🔤',title:'글자 크기 키우기',desc:'설정 > 글자 크기 설정에서 "크게" 또는 "아주크게"를 눌러 주세요.'},
];
function sideEffectDayHTML(key){
  const list=state.sideEffects.filter(x=>x.date===key);
  if(!list.length) return '';
  return `<div class="day-detail-title" style="margin-top:14px;">😣 불편했던 점</div>`+list.map(sideEffectRowHTML).join('');
}
function sideEffectRowHTML(x){
  const txt = x.symptom==='기타' && x.other ? `기타 · ${escapeHtml(x.other)}` : escapeHtml(x.symptom);
  const sl=slotLabelByKey(x.slot);
  const d=parseDateKey(x.date);
  return `<div class="se-row"><div class="se-main"><b>${txt}</b><span>${d.getMonth()+1}월 ${d.getDate()}일 · ${sl} 약</span></div><button class="se-del" type="button" data-se-del="${x.id}">삭제</button></div>`;
}
function sideEffectListHTML(n){
  const list=state.sideEffects.slice().sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).slice(0,n);
  return list.length ? list.map(sideEffectRowHTML).join('') : `<div class="hint-text" style="margin:0;">아직 기록이 없어요.</div>`;
}
function escapeHtml(t){ return String(t==null?'':t).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function bindSideEffectEvents(){
  document.querySelectorAll('#se-slots [data-se-slot]').forEach(b=>b.addEventListener('click',()=>{
    sideEffectDraft.slot=b.getAttribute('data-se-slot');
    document.querySelectorAll('#se-slots [data-se-slot]').forEach(x=>x.classList.toggle('checked',x===b));
  }));
  document.querySelectorAll('#se-symptoms .symptom-chip').forEach(b=>b.addEventListener('click',()=>{
    sideEffectDraft.symptom=b.getAttribute('data-sym');
    document.querySelectorAll('#se-symptoms .symptom-chip').forEach(x=>x.classList.toggle('on',x===b));
    document.getElementById('se-other-wrap').style.display = sideEffectDraft.symptom==='기타' ? '' : 'none';
  }));
  document.getElementById('se-save').addEventListener('click',()=>{
    if(!sideEffectDraft.symptom){ toast('불편한 점을 하나 골라 주세요.'); return; }
    let other='';
    if(sideEffectDraft.symptom==='기타'){
      other=document.getElementById('se-other').value.trim().slice(0,100);
      if(!other){ toast('어떤 점인지 적어 주세요.'); return; }
    }
    state.sideEffects.push({ id:'se_'+Date.now()+'_'+Math.floor(Math.random()*1000), date:dateKey(nowDate()), slot:sideEffectDraft.slot, symptom:sideEffectDraft.symptom, other, createdAt:nowDate().toISOString() });
    saveState();
    toast('불편한 점을 기록했어요.');
    openDetail('sideeffect');
    if(currentTab==='record') renderRecord();
  });
  document.querySelectorAll('#se-list [data-se-del]').forEach(b=>b.addEventListener('click',()=>deleteSideEffect(b.getAttribute('data-se-del'))));
}
function deleteSideEffect(id){
  state.sideEffects=state.sideEffects.filter(x=>x.id!==id);
  saveState();
  toast('기록을 삭제했어요.');
  if(currentDetail==='sideeffect') openDetail('sideeffect');
  if(currentTab==='record') renderRecord();
}
function markManualSeen(){ if(!state.manualSeen){ state.manualSeen=true; saveState(); } }
function maybeShowFirstRun(){
  if(state.manualSeen) return;
  const sh=document.getElementById('firstrun-sheet');
  sh.classList.add('show');
  document.getElementById('firstrun-open').onclick=()=>{ sh.classList.remove('show'); markManualSeen(); openDetail('manual'); };
  document.getElementById('firstrun-skip').onclick=()=>{ sh.classList.remove('show'); markManualSeen(); };
}

/* ================= 설정 ================= */
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
    {icon:'💊',label:'복약 관리',key:'manage'},
    {icon:'👪',label:'보호자 연동',key:'caregiver'},
    {icon:'🔤',label:'글자 크기 설정',key:'fontsize'},
    {icon:'📖',label:'앱 사용 방법',key:'manual'},
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
  // 예전 '복약 알림 설정'/'복약 정보 관리'는 하나의 '복약 관리' 화면으로 통합
  const wasMeds = (type==='meds');
  if(type==='alert'||type==='meds') type='manage';
  const ov=document.getElementById('detail-overlay');
  const keepScroll = (currentDetail==='manage' && type==='manage') ? ov.scrollTop : 0;
  currentDetail=type;
  if(!wasMeds && type!=='manage') editingMedId=null;
  const titles={
    manage:'복약 관리', caregiver:'보호자 연동',
    fontsize:'글자 크기 설정', manual:'앱 사용 방법', sideeffect:'불편한 점 기록', profile:'개인정보 보기', notifications:'알림',
  };
  document.getElementById('detail-title').textContent=titles[type]||'';
  document.getElementById('detail-body').innerHTML = detailBodyHTML(type);
  bindDetailEvents(type);
  ov.classList.add('show');
  if(keepScroll) ov.scrollTop=keepScroll;
}
function closeDetail(){
  document.getElementById('detail-overlay').classList.remove('show');
  currentDetail=null;
}
function switchHTML(id, checked){
  return `<label class="switch"><input type="checkbox" id="${id}" ${checked?'checked':''}><span class="track"></span><span class="thumb"></span></label>`;
}
function detailBodyHTML(type){
  if(type==='manage'){
    return `<p class="arc-card-title" style="margin:6px 2px 8px;">💊 복약 정보 관리</p>`+detailBodyHTML('meds')
      +`<p class="arc-card-title" style="margin:22px 2px 8px;">🔔 복약 알림 설정</p>`+detailBodyHTML('alert');
  }
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
        <div class="toggle-row"><span>🔔 차임벨 소리</span>${switchHTML('set-sound',state.soundAlert)}</div>
        <div class="toggle-row"><span>🔊 음성 복약 알림 ("약 먹을 시간입니다")</span>${switchHTML('set-voice',state.voiceReminderEnabled)}</div>
      </div>
      <div class="card pad-md">
        <span class="hint-text" style="margin-top:0;">끄면 음성 안내만 나오지 않고, 차임벨 소리·화면 알림·푸시 알림은 그대로 유지돼요.</span>
        <button class="btn-outline" id="preview-voice-btn" style="margin-top:10px;">🔊 음성 알림 테스트</button>
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
      </div>
      <div class="menu-group">
        <div class="toggle-row"><span>⏰ 복약 10분 전 미리 알림</span>${switchHTML('set-pre-reminder',state.preReminderEnabled)}</div>
        <div class="toggle-row"><span>🔁 놓치면 5분마다 다시 알림</span>${switchHTML('set-repeat-alarm',state.repeatAlarmEnabled)}</div>
      </div>
      <p class="hint-text">앱이 켜져 있을 때는 소리+음성이 바로 나와요. 앱을 닫아둔 상태에서는 푸시 알림(글자 안내)은 켜져 있으면 항상 오지만, 음성은 "알림을 탭해서 앱을 열 때" 확실하게 들려요. 화면이 완전히 꺼진 상태에서 탭 없이 자동으로 음성만 나오는 것은 iOS/Android 공통으로 웹 기술상 불가능해요.</p>`;
  }
  if(type==='meds'){
    const editingMed = editingMedId ? state.medications.find(m=>m.id===editingMedId) : null;
    return `
      <div class="card pad-md" id="med-list">${medListHTML()}</div>
      <div class="card pad-md">
        <p class="arc-card-title" style="margin-bottom:10px;">${editingMed ? '약 수정하기' : '약 추가하기'}</p>
        <div class="field"><label>약 이름</label><input type="text" id="new-med-name" placeholder="예: 혈압약" value="${editingMed?editingMed.name:''}"></div>
        <div class="field"><label>복용 시간대 (하나 이상 선택 - 눌러서 선택/해제)</label>
          <div class="tag-row" id="new-med-slots">${state.slots.map(s=>{
            const sel = editingMed ? editingMed.slots.includes(s.key) : false;
            return `<button type="button" class="tag-check ${sel?'checked':''}" data-slot="${s.key}">${s.icon} ${s.label}</button>`;
          }).join('')}</div>
        </div>
        <div class="field"><label>처방받은 날짜</label><input type="date" id="new-med-date" value="${editingMed?editingMed.prescriptionDate:''}"></div>
        <div class="field"><label>총 처방일수</label><input type="number" id="new-med-total" min="1" placeholder="예: 30" value="${editingMed?editingMed.totalDays:''}"></div>
        <button class="btn-primary" id="add-med-btn">${editingMed ? '수정 완료' : '+ 약 추가하기'}</button>
        ${editingMed ? `<button class="btn-outline" id="cancel-edit-med-btn" style="margin-top:8px;">취소</button>` : ''}
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
  if(type==='sideeffect'){
    const slots=activeSlots();
    const defSlot=(currentActiveSlot()||slots[0]||state.slots[0]).key;
    sideEffectDraft={symptom:null, slot:defSlot};
    const slotChips=(slots.length?slots:state.slots).map(sl=>`<button type="button" class="tag-check ${sl.key===defSlot?'checked':''}" data-se-slot="${sl.key}" style="min-height:52px;">${sl.icon} ${sl.label}</button>`).join('');
    const syms=SYMPTOMS.map(x=>`<button type="button" class="symptom-chip" data-sym="${x}">${x}</button>`).join('');
    return `
      <div class="card pad-md">
        <p class="arc-card-title" style="margin-bottom:6px;">어느 약을 드신 후인가요?</p>
        <div class="tag-row" id="se-slots">${slotChips}</div>
        <p class="arc-card-title" style="margin:16px 0 0;">어떤 점이 불편하셨나요?</p>
        <div class="symptom-grid" id="se-symptoms">${syms}</div>
        <div class="field" id="se-other-wrap" style="display:none;">
          <label>직접 적어주세요 (100자까지)</label>
          <input type="text" id="se-other" maxlength="100" placeholder="예: 입이 마르고 손이 떨려요">
        </div>
        <button class="btn-primary" id="se-save" type="button">기록하기</button>
        <p class="hint-text">심하거나 걱정되면 병원·약사님께 상담하세요.</p>
      </div>
      <div class="card pad-md">
        <p class="arc-card-title" style="margin-bottom:4px;">최근 기록</p>
        <div id="se-list">${sideEffectListHTML(8)}</div>
      </div>`;
  }
  if(type==='manual'){
    const cards=MANUAL_CARDS.map((c,i)=>`<div class="manual-card"><span class="mn">${i+1} / ${MANUAL_CARDS.length}</span><span class="mi">${c.icon}</span><h3>${c.title}</h3><p>${c.desc}</p></div>`).join('');
    return `<div style="padding-top:8px;">${cards}<button class="btn-primary" id="manual-close" type="button">알겠어요</button></div>`;
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
      <button class="btn-outline" style="min-height:38px; padding:0 14px; flex-shrink:0;" data-edit-med-id="${m.id}">수정</button>
      <button class="remove-btn" data-med-id="${m.id}">✕</button>
    </div>`;
  }).join('');
}
function bindDetailEvents(type){
  if(type==='manage'){ bindDetailEvents('meds'); bindDetailEvents('alert'); return; }
  if(type==='sideeffect') bindSideEffectEvents();
  if(type==='manual'){
    markManualSeen();
    const mc=document.getElementById('manual-close'); if(mc) mc.onclick=closeDetail;
  }
  if(type==='alert'){
    const pushBtn=document.getElementById('push-toggle-btn');
    if(pushBtn){
      pushBtn.addEventListener('click', async ()=>{
        if(pushEnabled){ await disablePushNotifications(); toast('푸시 알림을 껐어요.'); }
        else { await enablePushNotifications(); }
        openDetail('alert');
      });
    }
    document.getElementById('set-sound').addEventListener('change', e=>{ state.soundAlert=e.target.checked; toast(state.soundAlert?'차임벨 소리를 켰어요.':'차임벨 소리를 껐어요.'); saveState(); });
    document.getElementById('set-voice').addEventListener('change', e=>{ state.voiceReminderEnabled=e.target.checked; toast(state.voiceReminderEnabled?'음성 복약 알림을 켰어요.':'음성 복약 알림을 껐어요.'); saveState(); });
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
    document.querySelectorAll('#new-med-slots .tag-check').forEach(btn=>{
      btn.addEventListener('click', ()=>{ btn.classList.toggle('checked'); });
    });
    document.querySelectorAll('.remove-btn').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const id=btn.getAttribute('data-med-id');
        state.medications=state.medications.filter(m=>m.id!==id);
        if(editingMedId===id) editingMedId=null;
        toast('약을 삭제했어요.');
        syncPushConfig();
        renderAll();
        openDetail('meds');
      });
    });
    document.querySelectorAll('[data-edit-med-id]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        editingMedId=btn.getAttribute('data-edit-med-id');
        openDetail('meds');
      });
    });
    const cancelBtn=document.getElementById('cancel-edit-med-btn');
    if(cancelBtn) cancelBtn.addEventListener('click', ()=>{ editingMedId=null; openDetail('meds'); });

    document.getElementById('add-med-btn').addEventListener('click', ()=>{
      const name=document.getElementById('new-med-name').value.trim();
      const checked=Array.from(document.querySelectorAll('#new-med-slots .tag-check.checked')).map(b=>b.getAttribute('data-slot'));
      const date=document.getElementById('new-med-date').value;
      const total=Number(document.getElementById('new-med-total').value);
      if(!name){ toast('약 이름을 입력해 주세요.'); return; }
      if(!checked.length){ toast('복용 시간대를 하나 이상 선택해 주세요.'); return; }
      if(!date){ toast('처방받은 날짜를 입력해 주세요.'); return; }
      if(!total||total<=0){ toast('총 처방일수를 입력해 주세요.'); return; }

      if(editingMedId){
        const med=state.medications.find(m=>m.id===editingMedId);
        if(med){
          med.name=name; med.slots=checked; med.prescriptionDate=date; med.totalDays=total;
          toast(`${name} 정보를 수정했어요.`);
        }
        editingMedId=null;
      } else {
        state.medications.push({id:'m'+(state.medIdSeq++), name, dose:'1정', slots:checked, prescriptionDate:date, totalDays:total});
        toast(`${name}을(를) 추가했어요.`);
      }
      syncPushConfig();
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
  activeSlots().forEach((slot)=>{
    const i=slotIndex(slot);
    const slotMin=timeToMinutes(state.times[i]);
    const elapsed=curMin-slotMin;

    // 사전 알림 (선택지 없이 안내만)
    if(state.preReminderEnabled && !slot.taken && !slot.skipped && curMin===slotMin-state.preReminderOffset){
      const key=`pre_${slot.key}_${hh}:${mm}`;
      if(!state.alarmedSlots.has(key)){
        state.alarmedSlots.add(key);
        fireAlarm(`${slot.label} 약 먹을 시간이 곧 다가와요. 미리 준비해 주세요.`, {slotKey:slot.key, kind:'pre', withActions:false});
      }
    }

    // 정시 알림 - 복용함/건너뜀/나중에 3가지 선택지 제공
    if(curMin===slotMin && !slot.taken && !slot.skipped){
      const key=`on_${slot.key}_${hh}:${mm}`;
      if(!state.alarmedSlots.has(key)){
        state.alarmedSlots.add(key);
        fireAlarm('약 먹을 시간입니다', {slotKey:slot.key, kind:'on', withActions:true});
      }
    }

    // "나중에 복용"으로 미뤄둔 시각이 되면 한 번 더 알림 (무한반복 아님 - 한 번 울리고 스스로 정리됨)
    if(snoozeUntilMin[slot.key]!==undefined && !slot.taken && !slot.skipped){
      if(curMin>=snoozeUntilMin[slot.key] && elapsed<=AUTO_CLOSE_MINUTES){
        const key=`snooze_${slot.key}_${hh}:${mm}`;
        if(!state.alarmedSlots.has(key)){
          state.alarmedSlots.add(key);
          delete snoozeUntilMin[slot.key];
          fireAlarm(`${slot.label} 약 드셨나요? 아직이면 지금 챙겨보세요.`, {slotKey:slot.key, kind:'on', withActions:true});
        }
      } else if(elapsed>AUTO_CLOSE_MINUTES){
        delete snoozeUntilMin[slot.key];
      }
    }

    // (선택) 자동 반복 알림 - 설정한 경우에만, 2시간 안에서 5분 간격·최대 3회로 제한
    if(state.repeatAlarmEnabled && !slot.taken && !slot.skipped && curMin>slotMin && elapsed<AUTO_CLOSE_MINUTES){
      if(elapsed%5===0){
        const count=state.repeatCounts[slot.key]||0;
        const key=`rep_${slot.key}_${hh}:${mm}`;
        if(count<3 && !state.alarmedSlots.has(key)){
          state.alarmedSlots.add(key); state.repeatCounts[slot.key]=count+1;
          fireAlarm(`${slot.label} 약을 아직 못 드셨어요. 지금 챙겨보세요.`, {slotKey:slot.key, kind:'rep', withActions:true});
        }
      }
    }

    // 2시간이 지나도 선택이 없으면 알림을 완전히 닫고 미복용으로 확정 (slotStatusToday가 자동으로 'missed' 처리)
    if(!slot.taken && !slot.skipped && elapsed===AUTO_CLOSE_MINUTES){
      closeReminderNotification(slot.key);
      delete snoozeUntilMin[slot.key];
    }
  });
  renderAll();
}

/* text: 음성/토스트/알림에 쓸 문구. opts.slotKey가 있으면 그 시간대 전용 알림으로 간주해
   복용함/건너뜀/나중에 버튼(지원되는 환경에서만)을 붙이고, tag로 묶어 나중에 끌 수 있게 한다. */
function fireAlarm(text, opts){
  opts=opts||{};
  if(state.soundAlert) playChime();
  if(state.voiceReminderEnabled) speak(text);
  toast(text);
  state.notifLog.unshift({time:nowDate(), text});
  showReminderNotification(text, opts);
}
function showReminderNotification(text, opts){
  opts=opts||{};
  const withActions = !!opts.slotKey && opts.withActions!==false;
  const tag = opts.slotKey ? (opts.kind==='pre' ? `pre-${opts.slotKey}` : `reminder-${opts.slotKey}`) : 'onul-haenaesseoyo';
  const notifOptions={
    body:text, icon:'./icon-192.png', badge:'./icon-192.png',
    tag, renotify:true, vibrate:[200,100,200],
    data:{ slotKey: opts.slotKey||null, url:'./index.html' },
  };
  if(withActions){
    notifOptions.actions=[
      { action:'taken', title:'복용함' },
      { action:'skip', title:'건너뜀' },
      { action:'later', title:'나중에 복용' },
    ];
  }
  if('serviceWorker' in navigator){
    navigator.serviceWorker.ready.then(reg=>{
      reg.showNotification('오늘, 해냈어요', notifOptions).catch(()=>fallbackPlainNotification(text));
    }).catch(()=>fallbackPlainNotification(text));
  } else {
    fallbackPlainNotification(text);
  }
}
function fallbackPlainNotification(text){
  if('Notification' in window && Notification.permission==='granted'){
    try{ new Notification('오늘, 해냈어요', {body:text}); }catch(e){}
  }
}

/* ---------- 알림을 탭해서 앱이 열렸을 때: 즉시 음성 재생 ----------
   Service Worker가 notificationclick에서 "./index.html?speak=...&dedupe=..."로
   새 창을 열어주므로, 그 쿼리스트링을 읽어서 음성을 재생한다.
   같은 알림으로 이미 재생한 적이 있으면(state.alarmedSlots) 중복 재생하지 않는다. */
function handleSpeakFromUrlIfAny(){
  try{
    const params=new URLSearchParams(location.search);
    const text=params.get('speak');
    const dedupeKey=params.get('dedupe');
    const action=params.get('action');
    const slotKey=params.get('slot');

    // 앱이 완전히 닫힌 상태에서 알림의 "복용함/건너뜀/나중에" 버튼을 눌러 앱이 열린 경우
    if(action && slotKey){
      applyMedAction(action, slotKey);
    }

    if(text){
      const already = dedupeKey && state.alarmedSlots.has(dedupeKey);
      if(!already){
        if(dedupeKey) state.alarmedSlots.add(dedupeKey);
        if(state.voiceReminderEnabled) speak(text);
        saveState();
      }
    }
    if(text || action){
      // 새로고침해도 같은 알림이 다시 처리되지 않도록 주소에서 쿼리스트링 제거
      history.replaceState(null, '', location.pathname);
    }
  }catch(e){ /* 무시 */ }
}

/* 알림의 액션 버튼(복용함/건너뜀/나중에) 처리를 한곳에 모아둔 함수 -
   URL 파라미터 경로와 Service Worker 메시지 경로 둘 다 여기로 들어온다 */
function applyMedAction(action, slotKey){
  if(action==='taken') toggleSlot(slotKey);
  else if(action==='skip') skipSlotNow(slotKey);
  else if(action==='later') snoozeSlotNow(slotKey);
}

/* ---------- 앱이 이미 열려 있는 상태에서 서버 푸시가 도착했을 때: 즉시 음성 재생 ----------
   화면이 꺼져 있거나 앱이 완전히 종료된 상태에서는 페이지 자체가 없으므로
   이 메시지는 전달되지 않는다(= 그 경우는 "알림 탭 후 재생" 경로로만 가능). */
function setupServiceWorkerMessageListener(){
  if(!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (event)=>{
    const msg=event.data;
    if(!msg) return;
    if(msg.type==='voice-reminder'){
      const already = msg.dedupeKey && state.alarmedSlots.has(msg.dedupeKey);
      if(already) return; // 로컬 타이머(alarmTick)가 이미 같은 순간에 처리한 경우 - 중복 방지
      if(msg.dedupeKey) state.alarmedSlots.add(msg.dedupeKey);
      if(state.voiceReminderEnabled) speak(msg.text);
      saveState();
    } else if(msg.type==='med-action' && msg.slotKey && msg.action){
      // 앱이 열려 있는 상태에서 시스템 알림의 버튼을 누른 경우 - 바로 반영
      applyMedAction(msg.action, msg.slotKey);
    }
  });
}

/* ================= INIT ================= */
function init(){
  loadState();
  document.documentElement.style.fontSize=state.fontSize+'px';
  renderAll();
  handleSpeakFromUrlIfAny();
  maybeShowFirstRun();
  setupServiceWorkerMessageListener();
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
