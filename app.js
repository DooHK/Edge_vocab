/* ════════════════════════════════════════
   설정 (배포 후 변경)
════════════════════════════════════════ */
const API_BASE = 'https://edge-vocab-backend.onrender.com';
const GOOGLE_CLIENT_ID = '669898971300-ojr91etm7jss7i7e8fn3b189bbpfkg1t.apps.googleusercontent.com';

/* ════════════════════════════════════════
   PWA
════════════════════════════════════════ */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

let deferredInstall = null;

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
const isStandalone = window.matchMedia('(display-mode: standalone)').matches
                   || window.navigator.standalone === true;
const isInIframe = window.self !== window.top;

if (!isInIframe && !isStandalone) {
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstall = e;
    document.getElementById('installBanner').style.display = 'flex';
  });
  window.addEventListener('appinstalled', () => {
    document.getElementById('installBanner').style.display = 'none';
  });
  if (isIOS) {
    const banner = document.getElementById('installBanner');
    banner.innerHTML = '<span>Safari 공유 버튼에서 "홈 화면에 추가"를 선택하세요</span>' +
      '<button onclick="this.parentElement.style.display=\'none\'">닫기</button>';
    banner.style.display = 'flex';
  }
}

function installApp() {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  deferredInstall.userChoice.then(() => { deferredInstall = null; });
}

/* ════════════════════════════════════════
   Google Sign-In
════════════════════════════════════════ */
window.addEventListener('load', () => {
  if (getToken()) {
    showAppWithUser();
  } else {
    showLoginOverlay();
  }

  if (typeof google !== 'undefined' && google.accounts) {
    initGSI();
  } else {
    const checkGSI = setInterval(() => {
      if (typeof google !== 'undefined' && google.accounts) {
        clearInterval(checkGSI);
        initGSI();
      }
    }, 100);
  }

  // 자동추가 토글 초기화
  const autoToggle = document.getElementById('autoAddToggle');
  if (autoToggle) {
    autoToggle.checked = localStorage.getItem('vocab_auto_add') === 'true';
    autoToggle.addEventListener('change', () => {
      localStorage.setItem('vocab_auto_add', autoToggle.checked);
      if (getToken()) {
        apiRequest('PATCH', '/api/user/settings', { autoAdd: autoToggle.checked }).catch(() => {});
      }
    });
  }
});

function initGSI() {
  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: handleGoogleSignIn,
    auto_select: false
  });
  google.accounts.id.renderButton(
    document.getElementById('g_id_signin'),
    { theme: 'outline', size: 'large', text: 'sign_in_with', locale: 'ko' }
  );
}

function showLoginOverlay() {
  document.getElementById('loginOverlay').classList.add('show');
}

function showAppWithUser() {
  document.getElementById('loginOverlay').classList.remove('show');
  const name = localStorage.getItem('vocab_user_name');
  if (name) {
    document.getElementById('userName').textContent = name;
    document.getElementById('userInfo').style.display = 'flex';
    document.getElementById('avatar').textContent = name.charAt(0);
  }
  updateBadge();
  syncFromServer();
  loadFolders();
  loadUserSettings();
}

async function handleGoogleSignIn(response) {
  try {
    setSyncStatus('로그인 중...');
    const res = await fetch(`${API_BASE}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: response.credential })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || '서버 인증 실패');
    }
    const data = await res.json();
    localStorage.setItem('vocab_token', data.token);
    localStorage.setItem('vocab_user_name', data.name);
    localStorage.setItem('vocab_user_email', data.email);
    showAppWithUser();
    showToast(`${data.name}님 환영합니다!`);
  } catch (e) {
    clearSyncStatus();
    showToast('로그인 실패: ' + e.message);
  }
}

function continueOffline() {
  document.getElementById('loginOverlay').classList.remove('show');
  setOfflineStatus();
  updateBadge();
}

// 비로그인(오프라인)에서는 실제 사용 엔진(MyMemory)과 무료 플랜을 표시
function setOfflineStatus() {
  const planLabel = document.getElementById('currentPlan');
  const modelLabel = document.getElementById('currentModel');
  const banner = document.getElementById('upgradeBanner');
  if (planLabel) planLabel.textContent = '무료';
  if (modelLabel) modelLabel.textContent = 'MyMemory';
  if (banner) banner.style.display = 'flex';
}

function logout() {
  localStorage.removeItem('vocab_token');
  localStorage.removeItem('vocab_user_name');
  localStorage.removeItem('vocab_user_email');
  document.getElementById('userInfo').style.display = 'none';
  showLoginOverlay();
  showToast('로그아웃 되었습니다.');
}

/* ════════════════════════════════════════
   Auth helpers
════════════════════════════════════════ */
function getToken() { return localStorage.getItem('vocab_token'); }

async function apiRequest(method, path, body) {
  const token = getToken();
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API_BASE}${path}`, opts);
  if (res.status === 401) { logout(); throw new Error('인증 만료'); }
  return res;
}

/* ════════════════════════════════════════
   사용자 설정 로드
════════════════════════════════════════ */
async function loadUserSettings() {
  if (!getToken()) return;
  try {
    const res = await apiRequest('GET', '/api/user/settings');
    if (res.ok) {
      const data = await res.json();
      localStorage.setItem('vocab_auto_add', data.autoAdd);
      const toggle = document.getElementById('autoAddToggle');
      if (toggle) toggle.checked = data.autoAdd;
    }
  } catch {}

  // 플랜 상태 → 업그레이드 배너 + 플랜 + 모델 표시
  try {
    const statusRes = await apiRequest('GET', '/api/payment/status');
    if (statusRes.ok) {
      const status = await statusRes.json();
      const banner = document.getElementById('upgradeBanner');
      const planLabel = document.getElementById('currentPlan');
      const modelLabel = document.getElementById('currentModel');
      if (banner) banner.style.display = status.isPremium ? 'none' : 'flex';
      if (planLabel) planLabel.textContent = status.isPremium ? '프리미엄' : '무료';
      if (modelLabel) modelLabel.textContent = status.model || 'Google Translate';
    }
  } catch {}
}

/* ════════════════════════════════════════
   서버 동기화
════════════════════════════════════════ */
async function syncFromServer() {
  if (!getToken()) return;
  setSyncStatus('동기화 중...');
  try {
    const res = await apiRequest('GET', '/api/vocab');
    if (!res.ok) throw new Error();
    const serverList = await res.json();
    const vocab = serverList.map(v => ({
      id: v.id, word: v.word, translation: v.translation, date: v.date,
      folderId: v.folderId, folderName: v.folderName
    }));
    saveVocab(vocab);
    updateBadge();
    setSyncStatus('동기화 완료');
    setTimeout(clearSyncStatus, 2000);
  } catch {
    clearSyncStatus();
  }
}

function setSyncStatus(msg) {
  const el = document.getElementById('syncStatus');
  el.textContent = msg;
  el.classList.add('show');
}
function clearSyncStatus() {
  document.getElementById('syncStatus').classList.remove('show');
}

/* ════════════════════════════════════════
   Views (1c 홈 ↔ 1d 라이브러리)
════════════════════════════════════════ */
let activePane = 'search'; // 'search' | 'quiz' | 'library'

function showHome() {
  document.getElementById('libraryView').style.display = 'none';
  document.getElementById('homeView').style.display = 'flex';
  if (activePane === 'library') activePane = 'search';
  document.getElementById('quizArea').style.display = activePane === 'quiz' ? 'block' : 'none';
  updateHomePanels();
  renderNav();
  if (activePane === 'search') document.getElementById('wordInput').focus();
}

function showQuiz() {
  document.getElementById('libraryView').style.display = 'none';
  document.getElementById('homeView').style.display = 'flex';
  activePane = 'quiz';
  document.getElementById('searchHome').style.display = 'none';
  document.getElementById('resultCard').classList.remove('show');
  document.getElementById('quizArea').style.display = 'block';
  renderNav();
  showQuizSetup();
}

function showLibrary(folderId) {
  selectedFolderId = folderId;
  activePane = 'library';
  document.getElementById('homeView').style.display = 'none';
  document.getElementById('libraryView').style.display = 'flex';
  renderNav();
  renderLibTabs();
  renderLibrary();
  if (getToken()) loadFolders();
}

function updateHomePanels() {
  if (activePane === 'quiz') return;
  const entryShown = document.getElementById('resultCard').classList.contains('show');
  document.getElementById('searchHome').style.display = entryShown ? 'none' : 'block';
}

function goSearch() {
  activePane = 'search';
  showHome();
}

function handleLibKey(e) {
  if (e.key !== 'Enter') return;
  const v = e.target.value.trim();
  if (!v) return;
  e.target.value = '';
  goSearch();
  document.getElementById('wordInput').value = v;
  doTranslate();
}

/* ── 모바일 하단 탭바 ── */
function mobileGo(tab) {
  if (tab === 'translate') goSearch();
  else if (tab === 'vocab') showLibrary(selectedFolderId ?? null);
  else if (tab === 'quiz') showQuiz();
}

function updateMobileTab() {
  const map = { search: 'translate', quiz: 'quiz', library: 'vocab' };
  const active = map[activePane] || 'translate';
  document.querySelectorAll('.mobile-tabbar [data-mtab]').forEach(b =>
    b.classList.toggle('active', b.dataset.mtab === active)
  );
}

/* ════════════════════════════════════════
   Translation (Google Translate via backend)
════════════════════════════════════════ */
let curWord = '', curTrans = '', alreadyAdded = false;

function handleKey(e) { if (e.key === 'Enter') doTranslate(); }

async function doTranslate() {
  const raw = document.getElementById('wordInput').value.trim();
  if (!raw) return;

  curWord = raw;
  entryWord = raw;
  alreadyAdded = false;
  detailIdx = null;

  const loading = document.getElementById('loading');
  const card    = document.getElementById('resultCard');

  activePane = 'search';
  document.getElementById('quizArea').style.display = 'none';
  document.getElementById('searchHome').style.display = 'none';
  document.getElementById('detailDeleteBtn').style.display = 'none';
  showUnsavedState();
  renderNav();
  loading.classList.add('show');
  card.classList.remove('show');
  updateEntryExtras(raw); // 사전 조회를 번역과 동시에 시작 (병렬)

  try {
    let translated;

    if (getToken()) {
      // 로그인 사용자: 서버 Google Translate API
      const res = await apiRequest('POST', '/api/translate', {
        text: raw, source: 'en', target: 'ko'
      });

      if (res.status === 402) {
        showToast('월 무료 번역 한도를 초과했습니다. 프리미엄으로 업그레이드하세요!');
        loading.classList.remove('show');
        updateHomePanels();
        return;
      }
      if (!res.ok) throw new Error('번역 실패');

      const data = await res.json();
      translated = data.translated;
    } else {
      // 비로그인: MyMemory fallback
      const url  = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(raw)}&langpair=en|ko`;
      const res  = await fetch(url);
      const data = await res.json();
      if (data.responseStatus !== 200) throw new Error('번역 실패');
      translated = data.responseData.translatedText;
    }

    curTrans = translated;

    document.getElementById('resultEn').textContent = raw;
    document.getElementById('resultKo').textContent = translated;
    renderExtraSenses(entryDict); // 주 번역 확정 후 여러 뜻 중복 제거하여 재렌더

    const existing = getVocab().find(v => v.word.toLowerCase() === raw.toLowerCase());
    if (existing) {
      alreadyAdded = true;
      detailIdx = getVocab().indexOf(existing);
      showSavedState(existing.folderId ?? null);
    } else {
      alreadyAdded = false;
      showUnsavedState();
    }

    card.classList.add('show');

    // 자동 추가
    if (!existing && localStorage.getItem('vocab_auto_add') === 'true') {
      await addToVocab();
    }
  } catch {
    showToast('네트워크 오류가 발생했습니다.');
  } finally {
    loading.classList.remove('show');
    updateHomePanels();
  }
}

const SAVE_ICON = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" style="vertical-align:-3px;margin-right:6px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

/* ════════════════════════════════════════
   사전 정보 (발음기호 · 품사 · 예문)
   - 발음기호/품사: Free Dictionary API
   - 예문: 사전 API → 없으면 Tatoeba 폴백
   - 예문 한국어 번역: MyMemory (무료, 실패 시 영문만 표시)
   - 로컬 캐시(localStorage)
════════════════════════════════════════ */
let entryWord = ''; // 현재 상세 뷰에 표시 중인 단어 (비동기 갱신 가드)
const DICT_KEY = 'vocab_dict_v4';

function getDictCache() { return JSON.parse(localStorage.getItem(DICT_KEY) || '{}'); }

function saveDictEntry(word, info) {
  const cache = getDictCache();
  cache[word.toLowerCase()] = info;
  const keys = Object.keys(cache);
  if (keys.length > 500) delete cache[keys[0]];
  localStorage.setItem(DICT_KEY, JSON.stringify(cache));
}

async function fetchExampleFromTatoeba(word) {
  try {
    const res = await fetch(`https://api.tatoeba.org/unstable/sentences?lang=eng&q=${encodeURIComponent(word)}&sort=relevance&limit=10`);
    if (!res.ok) return '';
    const data = await res.json();
    const items = (data.data || []).map(s => s.text).filter(Boolean);
    if (!items.length) return '';
    const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const exact = items.filter(t => re.test(t));
    const pool = exact.length ? exact : items;
    // 카드에 담기 좋은 중간 길이 문장 우선
    return pool.find(t => t.length >= 25 && t.length <= 120) || pool[0];
  } catch { return ''; }
}

// 구글 사전 데이터(비공식·무료)에서 품사별 여러 한국어 뜻을 가져온다
async function fetchGoogleMeanings(word) {
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ko&dt=bd&q=${encodeURIComponent(word)}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    const dict = data[1]; // 사전(dictionary) 블록
    if (!Array.isArray(dict)) return [];
    const out = [], seen = new Set();
    for (const entry of dict) {
      const pos = entry[0] || '';       // 품사 (noun, verb, ...)
      const glosses = entry[1] || [];   // ["빛","불", ...]
      for (const g of glosses) {
        if (g && !seen.has(g)) { seen.add(g); out.push({ pos, gloss: g }); }
        if (out.length >= 8) break;
      }
      if (out.length >= 8) break;
    }
    return out;
  } catch { return []; }
}

async function fetchDictInfo(word) {
  if (!/^[a-zA-Z][a-zA-Z'-]*$/.test(word)) return null; // 단일 단어만 (문장 제외)
  const key = word.toLowerCase();
  const cached = getDictCache()[key];
  if (cached) return cached;

  let phonetic = '', pos = '', exampleEn = '';
  const defs = [];                  // 추가 뜻 (영어 정의) [{pos, text}]
  const syns = new Set(), ants = new Set(); // 유의어 / 반의어

  // 사전 API · Tatoeba · 구글 여러뜻을 동시에 출발시켜 순차 대기 제거
  const tatoebaPromise = fetchExampleFromTatoeba(key);
  const meaningsPromise = fetchGoogleMeanings(key);

  try {
    const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(key)}`);
    if (res.ok) {
      const data = await res.json();
      const entry = Array.isArray(data) ? data[0] : null;
      if (entry) {
        phonetic = entry.phonetic
          || (entry.phonetics || []).map(p => p.text).find(Boolean) || '';
        for (const m of (entry.meanings || [])) {
          if (!pos) pos = m.partOfSpeech || '';
          (m.synonyms || []).forEach(s => syns.add(s));
          (m.antonyms || []).forEach(a => ants.add(a));
          let pushed = false;
          for (const d of (m.definitions || [])) {
            if (!pushed && d.definition && defs.length < 3) { defs.push({ pos: m.partOfSpeech || '', text: d.definition }); pushed = true; }
            if (!exampleEn && d.example) exampleEn = d.example;
            (d.synonyms || []).forEach(s => syns.add(s));
            (d.antonyms || []).forEach(a => ants.add(a));
          }
        }
      }
    }
  } catch {}

  if (!exampleEn) exampleEn = await tatoebaPromise;
  const meanings = await meaningsPromise;
  if (!phonetic && !pos && !exampleEn && !defs.length && !meanings.length) return null; // 아무것도 못 찾으면 캐시하지 않음

  const info = {
    phonetic, pos, exampleEn, exampleKo: '',
    defs, meanings,
    synonyms: [...syns].slice(0, 4),
    antonyms: [...ants].slice(0, 2)
  };
  saveDictEntry(key, info);
  return info;
}

async function ensureExampleKo(word, dict) {
  if (!dict.exampleEn || dict.exampleKo) return dict.exampleKo || '';
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(dict.exampleEn)}&langpair=en|ko`;
    const res  = await fetch(url);
    const data = await res.json();
    if (data.responseStatus === 200 && data.responseData.translatedText) {
      dict.exampleKo = data.responseData.translatedText;
      saveDictEntry(word, dict);
      return dict.exampleKo;
    }
  } catch {}
  return '';
}

function setEntrySub({ phonetic = '', tail = '' } = {}) {
  let html = phonetic ? escHtml(phonetic) : '';
  if (tail) html += (html ? ' · ' : '') + tail;
  document.getElementById('resultMeta').innerHTML = html;
}

function setEntryPos(pos) {
  const el = document.getElementById('resultPos');
  el.textContent = pos || '';
  el.style.display = pos ? 'inline-block' : 'none';
}

function boldWord(sentence, word) {
  const safe = escHtml(sentence);
  const pattern = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(`\\b(${pattern}[a-z]*)`, 'gi'), '<b>$1</b>');
}

function hideExample() {
  document.getElementById('exampleBox').style.display = 'none';
}

function showExample(word, dict) {
  if (!dict.exampleEn) { hideExample(); return; }
  document.getElementById('exampleEn').innerHTML = boldWord(dict.exampleEn, word);
  const koLine = document.getElementById('exampleKoLine');
  koLine.textContent = dict.exampleKo || '';
  koLine.style.display = dict.exampleKo ? 'block' : 'none';
  document.getElementById('exampleBox').style.display = 'block';
  ensureExampleKo(word, dict).then(ko => {
    if (ko && entryWord === word) {
      koLine.textContent = ko;
      koLine.style.display = 'block';
    }
  });
}

/* 발음 듣기 (Web Speech API) */
function speakWord(word) {
  if (!('speechSynthesis' in window) || !word) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(word);
  u.lang = 'en-US';
  speechSynthesis.speak(u);
}

/* 추가 뜻 (한국어 여러 뜻, 2번부터) — 없으면 영어 정의로 폴백 */
function renderExtraSenses(dict) {
  const box = document.getElementById('extraSenses');
  const primary = (curTrans || '').trim();
  const meanings = ((dict && dict.meanings) || [])
    .filter(m => m.gloss !== primary)
    .slice(0, 5);

  let list;
  if (meanings.length) {
    list = meanings.map(m => ({ text: m.gloss, pos: m.pos }));
  } else {
    list = ((dict && dict.defs) || []).map(d => ({ text: d.text, pos: d.pos }));
  }

  box.style.display = list.length ? 'flex' : 'none';
  box.innerHTML = list.map((d, i) => `
    <div class="sense">
      <span class="sense__num">${i + 2}</span>
      <div class="sense__def">${escHtml(d.text)}${d.pos ? ` <span class="sense__def-pos">· ${escHtml(d.pos)}</span>` : ''}</div>
    </div>`).join('');
}

/* 유의어 · 반의어 태그 */
function renderRelated(dict) {
  const box = document.getElementById('relatedTags');
  const syns = (dict && dict.synonyms) || [];
  const ants = (dict && dict.antonyms) || [];
  if (!syns.length && !ants.length) { box.innerHTML = ''; box.style.display = 'none'; return; }
  const tag = (label, w) =>
    `<button class="tag" onclick="searchRelated('${escAttr(w)}')">${label ? label + ' · ' : ''}${escHtml(w)}</button>`;
  box.innerHTML =
    syns.map((s, i) => tag(i === 0 ? '유의어' : '', s)).join('') +
    ants.map((a, i) => tag(i === 0 ? '반의어' : '', a)).join('');
  box.style.display = 'flex';
}

function searchRelated(w) {
  goSearch();
  document.getElementById('wordInput').value = w;
  doTranslate();
}

let entryDict = null; // 현재 표시 중인 단어의 사전 정보 (번역 확정 후 재렌더용)

function updateEntryExtras(word) {
  entryDict = null;
  setEntrySub({});
  setEntryPos('');
  hideExample();
  renderExtraSenses(null);
  renderRelated(null);
  fetchDictInfo(word).then(dict => {
    if (!dict || entryWord !== word) return;
    entryDict = dict;
    setEntrySub({ phonetic: dict.phonetic });
    setEntryPos(dict.pos);
    showExample(word, dict);
    renderExtraSenses(dict);
    renderRelated(dict);
  });
}

/* ── 저장 위치(폴더) 선택 — 유튜브 뮤직 라이브러리 방식 ── */
const SAVE_FOLDER_KEY = 'vocab_save_folder';
let pickerForMove = false; // true면 이미 저장된 단어의 폴더 이동

function getSaveFolderId() {
  const raw = localStorage.getItem(SAVE_FOLDER_KEY);
  if (raw === null) return undefined;  // 한 번도 저장 안 함
  if (raw === 'all') return null;      // 전체(폴더 없음)
  return parseInt(raw);
}
function setSaveFolderId(id) {
  localStorage.setItem(SAVE_FOLDER_KEY, id == null ? 'all' : String(id));
}
function saveFolderLabel(id) {
  if (id == null) return '전체';
  const f = folders.find(f => f.id === id);
  return f ? f.name : '전체';
}

async function addToVocab() {
  if (alreadyAdded || !curWord) return;
  if (getVocab().some(v => v.word.toLowerCase() === curWord.toLowerCase())) {
    showToast('이미 단어장에 있습니다.');
    return;
  }
  // 첫 저장은 무조건 저장 위치를 먼저 고르게 한다
  if (getSaveFolderId() === undefined) {
    openFolderPicker(false);
    return;
  }
  await saveWordToFolder(getSaveFolderId() ?? null);
}

async function saveWordToFolder(folderId) {
  const newItem = { word: curWord, translation: curTrans, date: today() };

  if (getToken()) {
    if (folderId != null) newItem.folderId = folderId;
    try {
      const res = await apiRequest('POST', '/api/vocab', {
        word: newItem.word, translation: newItem.translation,
        date: newItem.date, folderId: folderId
      });
      if (!res.ok) throw new Error();
      const saved = await res.json();
      newItem.id = saved.id;
      newItem.folderName = saved.folderName;
    } catch {
      showToast('서버 저장 실패. 로컬에만 저장됩니다.');
    }
  }

  const vocab = getVocab();
  vocab.unshift(newItem);
  saveVocab(vocab);
  setSaveFolderId(folderId);
  alreadyAdded = true;
  detailIdx = 0;
  updateBadge();
  showSavedState(folderId);
  showToast(`"${curWord}" 저장됨`);
}

// 저장 완료 상태 표시 ("○○에 저장됨 · 저장 위치 변경")
function showSavedState(folderId) {
  document.getElementById('addBtn').style.display = 'none';
  document.getElementById('savedFolderName').textContent = saveFolderLabel(folderId);
  document.getElementById('savedRow').style.display = 'flex';
  document.getElementById('changeFolderBtn').style.display = getToken() ? '' : 'none';
}

// 저장 전(검색 결과) 상태로 되돌림
function showUnsavedState() {
  const addBtn = document.getElementById('addBtn');
  addBtn.style.display = 'flex';
  addBtn.innerHTML = SAVE_ICON + '단어장에 저장';
  addBtn.className = 'save-btn';
  document.getElementById('savedRow').style.display = 'none';
  document.getElementById('folderPicker').style.display = 'none';
}

/* ── 폴더 선택 피커 (선택 + 새 폴더 생성) ── */
function openFolderPicker(forMove) {
  pickerForMove = forMove;
  const current = forMove
    ? (getVocab()[detailIdx]?.folderId ?? null)
    : (getSaveFolderId() ?? null);

  let html = folderPickerRow(null, '전체', current);
  folders.forEach(f => { html += folderPickerRow(f.id, f.name, current); });
  html += `
    <div class="picker-new">
      <input id="pickerNewInput" type="text" placeholder="+ 새 폴더 만들기" autocomplete="off"
             onkeydown="if(event.key==='Enter')createFolderFromPicker()" />
      <button onclick="createFolderFromPicker()">추가</button>
    </div>`;

  const picker = document.getElementById('folderPicker');
  picker.innerHTML = html;
  picker.style.display = 'block';
}

function folderPickerRow(id, name, current) {
  const active = id === current;
  return `<button class="picker-item${active ? ' active' : ''}" onclick="pickFolder(${id === null ? 'null' : id})">
    <span class="picker-check">${active ? '✓' : ''}</span><span class="picker-name">${escHtml(name)}</span></button>`;
}

async function pickFolder(folderId) {
  document.getElementById('folderPicker').style.display = 'none';
  if (pickerForMove) {
    const v = getVocab()[detailIdx];
    if (v && v.id) await moveWordToFolder(v.id, folderId);
    else if (v) {
      v.folderId = folderId || undefined;
      v.folderName = folderId ? saveFolderLabel(folderId) : undefined;
      saveVocab(getVocab());
    }
    setSaveFolderId(folderId);
    const idx = getVocab().findIndex(x => (v?.id && x.id === v.id) || (x.word === v?.word && x.date === v?.date));
    if (idx >= 0) detailIdx = idx;
    showSavedState(folderId);
  } else {
    setSaveFolderId(folderId);
    await saveWordToFolder(folderId);
  }
}

function toggleFolderPicker() {
  const picker = document.getElementById('folderPicker');
  if (picker.style.display === 'block') { picker.style.display = 'none'; return; }
  openFolderPicker(true);
}

async function createFolderFromPicker() {
  const input = document.getElementById('pickerNewInput');
  const name = (input.value || '').trim();
  if (!name) return;
  if (!getToken()) { showToast('로그인이 필요합니다.'); return; }
  try {
    const res = await apiRequest('POST', '/api/folders', { name });
    if (!res.ok) { const e = await res.json().catch(() => ({})); showToast(e.error || '폴더 생성 실패'); return; }
    const folder = await res.json();
    await loadFolders();
    showToast(`"${name}" 폴더 생성`);
    pickFolder(folder.id);
  } catch { showToast('폴더 생성 실패'); }
}

/* ════════════════════════════════════════
   Folders
════════════════════════════════════════ */
let folders = [];
let selectedFolderId = null; // null = 전체, 0 = 미분류, -1 = 틀린 단어

async function loadFolders() {
  if (!getToken()) { folders = []; renderNav(); renderLibTabs(); return; }
  try {
    const res = await apiRequest('GET', '/api/folders');
    if (res.ok) folders = await res.json();
  } catch { folders = []; }
  renderNav();
  renderLibTabs();
}

const DOT_COLORS = ['#6d5bd6', '#16a34a', '#f59e0b', '#0ea5e9', '#ef4444', '#14b8a6'];

function folderNameOf(id) {
  if (id === null) return '전체';
  if (id === 0)    return '미분류';
  if (id === -1)   return '틀린 단어';
  const f = folders.find(f => f.id === id);
  return f ? f.name : '전체';
}

function renderNav() {
  const container = document.getElementById('navFolders');
  if (!container) return;
  const vocab = getVocab();
  const wrongWords = getLocalWrongWords();
  const uncatCount = vocab.filter(v => !v.folderId).length;
  const wrongCount = vocab.filter(v => wrongWords.has(v.word.toLowerCase())).length;
  const isLib = activePane === 'library';

  const row = (id, name, dot, count) => {
    const active = isLib && selectedFolderId === id;
    return `
    <button class="folder${active ? ' folder--active' : ''}" onclick="showLibrary(${id})">
      <span class="folder__dot" style="background:${active ? '#fff' : dot}"></span>
      <span class="folder__name">${escHtml(name)}</span>
      <span class="folder__count">${count}</span>
    </button>`;
  };

  let html = row(null, '전체', '#18181b', vocab.length);
  html += row(0, '미분류', '#a1a1aa', uncatCount);
  html += row(-1, '틀린 단어', '#ef4444', wrongCount);
  folders.forEach((f, i) => {
    html += row(f.id, f.name, DOT_COLORS[i % DOT_COLORS.length], f.wordCount);
  });
  container.innerHTML = html;

  const quizBtn = document.getElementById('quizNavBtn');
  if (quizBtn) quizBtn.classList.toggle('folder--active', activePane === 'quiz');

  updateMobileTab();
}

function renderLibTabs() {
  const container = document.getElementById('libTabs');
  if (!container) return;
  const tab = (id, name) =>
    `<button class="tab${selectedFolderId === id ? ' tab--active' : ''}" onclick="showLibrary(${id})">${escHtml(name)}</button>`;
  let html = tab(null, '전체') + tab(0, '미분류') + tab(-1, '틀린 단어');
  folders.forEach(f => { html += tab(f.id, f.name); });
  html += `<button class="tab tab--add" onclick="showCreateFolder()">+ 새 폴더</button>`;
  container.innerHTML = html;
}

async function showCreateFolder() {
  const name = prompt('새 폴더 이름:');
  if (!name || !name.trim()) return;
  if (!getToken()) { showToast('로그인이 필요합니다.'); return; }

  try {
    const res = await apiRequest('POST', '/api/folders', { name: name.trim() });
    if (!res.ok) {
      const err = await res.json();
      showToast(err.error || '폴더 생성 실패');
      return;
    }
    await loadFolders();
    showToast(`"${name.trim()}" 폴더 생성!`);
  } catch {
    showToast('폴더 생성 실패');
  }
}

async function deleteFolder(folderId) {
  if (!confirm('이 폴더를 삭제할까요? (단어는 전체에 남습니다)')) return;
  try {
    await apiRequest('DELETE', `/api/folders/${folderId}`);
    if (selectedFolderId === folderId) selectedFolderId = null;
    await loadFolders();
    await syncFromServer();
    renderLibrary();
    showToast('폴더 삭제 완료');
  } catch {
    showToast('폴더 삭제 실패');
  }
}

async function moveWordToFolder(vocabId, folderId) {
  try {
    await apiRequest('PATCH', `/api/vocab/${vocabId}/folder`, { folderId });
    await syncFromServer();
    await loadFolders();
    renderLibrary();
    showToast('폴더 이동 완료');
  } catch {
    showToast('폴더 이동 실패');
  }
}


/* ════════════════════════════════════════
   Vocabulary CRUD
════════════════════════════════════════ */
async function deleteWord(idx) {
  const vocab = getVocab();
  const item  = vocab[idx];

  if (getToken() && item.id) {
    try {
      await apiRequest('DELETE', `/api/vocab/${item.id}`);
    } catch {
      showToast('서버 삭제 실패');
      return;
    }
  }

  vocab.splice(idx, 1);
  saveVocab(vocab);
  renderLibrary();
  updateBadge();
  showToast(`"${item.word}" 삭제됨`);
}

async function clearAll() {
  if (!getVocab().length) return;
  if (!confirm('단어장을 전부 삭제할까요?')) return;

  if (getToken()) {
    try {
      await apiRequest('DELETE', '/api/vocab/all');
    } catch {
      showToast('서버 삭제 실패');
      return;
    }
  }

  saveVocab([]);
  renderLibrary();
  updateBadge();
  showToast('단어장을 비웠습니다.');
}

function renderLibrary() {
  const list = document.getElementById('vocabList');
  if (!list) return;
  const queryEl  = document.getElementById('libSearch');
  const query    = ((queryEl && queryEl.value) || '').toLowerCase().trim();
  const allVocab = getVocab();

  let filtered = allVocab;

  if (selectedFolderId === 0) {
    // 미분류 (폴더 없는 단어)
    filtered = allVocab.filter(v => !v.folderId);
  } else if (selectedFolderId === -1) {
    // 틀린 단어 (로컬 퀴즈 결과 기반)
    const wrongWords = getLocalWrongWords();
    filtered = allVocab.filter(v =>
      wrongWords.has(v.word.toLowerCase())
    );
  } else if (selectedFolderId !== null) {
    filtered = allVocab.filter(v => v.folderId === selectedFolderId);
  }

  if (query) {
    filtered = filtered.filter(v =>
      v.word.toLowerCase().includes(query) || v.translation.includes(query)
    );
  }

  document.getElementById('libTitle').textContent = folderNameOf(selectedFolderId);
  document.getElementById('libSub').textContent =
    `${filtered.length}개 단어${query ? ` · "${query}" 검색 중` : ''}`;

  const folderDelBtn = document.getElementById('folderDeleteBtn');
  if (folderDelBtn) {
    folderDelBtn.style.display =
      (typeof selectedFolderId === 'number' && selectedFolderId > 0) ? '' : 'none';
  }

  if (!filtered.length) {
    list.innerHTML = `<div class="empty-msg">
      <span class="empty-icon">${query ? '🔍' : '📭'}</span>
      ${query ? '검색 결과가 없습니다.' : selectedFolderId === -1 ? '틀린 단어가 없습니다!' : '아직 저장된 단어가 없어요.<br>검색해서 단어를 추가해보세요!'}
    </div>`;
    return;
  }

  const dictCache = getDictCache();
  list.innerHTML = filtered.map(v => {
    const origIdx = allVocab.findIndex(x => x.word === v.word && x.date === v.date);
    const dict = dictCache[v.word.toLowerCase()] || {};
    const pos  = dict.pos ? `<span class="wcard__pos">${escHtml(dict.pos)}</span>` : '';
    const phon = dict.phonetic ? `<div class="wcard__phonetic">${escHtml(dict.phonetic)}</div>` : '';
    const ex   = dict.exampleEn ? `<div class="wcard__ex">${boldWord(dict.exampleEn, v.word)}</div>` : '';
    const folderTag = v.folderName ? ` <span class="wcard__folder">${escHtml(v.folderName)}</span>` : '';
    return `
      <div class="wcard" onclick="showWordDetail(${origIdx})">
        <button class="wcard__del" onclick="event.stopPropagation();deleteWord(${origIdx})" aria-label="삭제">✕</button>
        <div class="wcard__top">
          <div class="wcard__word">${escHtml(v.word)}</div>
          ${pos}
        </div>
        ${phon}
        <div class="wcard__ko">${escHtml(v.translation)}</div>
        ${ex}
        <div class="wcard__date">${v.date}${folderTag}</div>
      </div>`;
  }).join('') + `
      <button class="wcard wcard--add" onclick="goSearch()">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        <span>검색해서 단어 추가</span>
      </button>`;
}

/* ── 폴더 관리 ── */
function deleteCurrentFolder() {
  if (typeof selectedFolderId === 'number' && selectedFolderId > 0) {
    deleteFolder(selectedFolderId);
  }
}

/* ── 라이브러리 설정 메뉴 (내보내기/가져오기/전체삭제) ── */
function toggleLibMenu(e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById('libMenu');
  menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
}
function closeLibMenu() {
  const menu = document.getElementById('libMenu');
  if (menu) menu.style.display = 'none';
}

// 바깥 클릭 시 열린 팝업(폴더 피커 · 설정 메뉴) 닫기
document.addEventListener('click', e => {
  if (!e.target.closest('.save-wrap')) {
    const picker = document.getElementById('folderPicker');
    if (picker) picker.style.display = 'none';
  }
  if (!e.target.closest('.lib-actions')) closeLibMenu();
});

/* ── 저장된 단어 상세 (1c entry 재사용) ── */
let detailIdx = null;

function showWordDetail(idx) {
  const v = getVocab()[idx];
  if (!v) return;
  detailIdx = idx;
  activePane = 'search';
  document.getElementById('libraryView').style.display = 'none';
  document.getElementById('homeView').style.display = 'flex';
  document.getElementById('quizArea').style.display = 'none';
  document.getElementById('searchHome').style.display = 'none';

  entryWord = v.word;
  curWord = v.word;
  curTrans = v.translation;
  alreadyAdded = true;
  document.getElementById('resultEn').textContent = v.word;
  document.getElementById('resultKo').textContent = v.translation;
  const tail = `<span class="sub-date">${v.date} 저장</span>`;
  setEntrySub({ tail });
  setEntryPos('');
  hideExample();
  renderExtraSenses(null);
  renderRelated(null);
  fetchDictInfo(v.word).then(dict => {
    if (!dict || entryWord !== v.word) return;
    setEntrySub({ phonetic: dict.phonetic, tail });
    setEntryPos(dict.pos);
    showExample(v.word, dict);
    renderExtraSenses(dict);
    renderRelated(dict);
  });
  showSavedState(v.folderId ?? null);
  document.getElementById('detailDeleteBtn').style.display = 'flex';
  document.getElementById('resultCard').classList.add('show');
  renderNav();
}

async function deleteDetailWord() {
  if (detailIdx === null) return;
  const idx = detailIdx;
  detailIdx = null;
  await deleteWord(idx);
  document.getElementById('resultCard').classList.remove('show');
  document.getElementById('detailDeleteBtn').style.display = 'none';
  showUnsavedState();
  updateHomePanels();
}

/* ════════════════════════════════════════
   Export / Import CSV
════════════════════════════════════════ */
function exportCSV() {
  const vocab = getVocab();
  if (!vocab.length) { showToast('저장된 단어가 없습니다.'); return; }
  const rows  = ['단어,번역,날짜', ...vocab.map(v => `"${v.word}","${v.translation}","${v.date}"`)];
  const blob  = new Blob(['\uFEFF' + rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const a     = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob), download: '영어단어장.csv'
  });
  a.click();
  showToast('CSV 파일 다운로드 완료!');
}

function importCSV() { document.getElementById('importFile').click(); }

async function handleImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async ev => {
    const lines = ev.target.result.replace(/^\uFEFF/, '').split('\n').slice(1);
    const vocab = getVocab();
    let added = 0;
    const toAdd = [];

    lines.forEach(line => {
      const cols = line.match(/"([^"]*)"/g);
      if (!cols || cols.length < 2) return;
      const word = cols[0].replace(/"/g, '').trim();
      const tr   = cols[1].replace(/"/g, '').trim();
      const date = cols[2] ? cols[2].replace(/"/g, '').trim() : today();
      if (!word || vocab.some(v => v.word.toLowerCase() === word.toLowerCase())) return;
      toAdd.push({ word, translation: tr, date });
    });

    for (const item of toAdd) {
      if (getToken()) {
        try {
          const res = await apiRequest('POST', '/api/vocab', item);
          if (res.ok) { const saved = await res.json(); item.id = saved.id; }
        } catch {}
      }
      vocab.push(item);
      added++;
    }

    saveVocab(vocab);
    renderLibrary();
    updateBadge();
    showToast(`${added}개 단어 가져오기 완료!`);
    e.target.value = '';
  };
  reader.readAsText(file, 'utf-8');
}

/* ════════════════════════════════════════
   Quiz - 새 퀴즈 시스템
════════════════════════════════════════ */
let quizList = [], quizIdx = 0, quizMode = 'multiple', quizResults = [];

function showQuizSetup() {
  const vocab = getVocab();
  const area = document.getElementById('quizArea');

  if (vocab.length < 2) {
    area.innerHTML = `<div class="quiz-empty">단어장에 단어를 2개 이상 추가하세요!</div>`;
    return;
  }

  // 통계 로드
  let statsHtml = '';
  const localStats = getLocalQuizStats();
  if (localStats.total > 0) {
    statsHtml = `
      <div class="quiz-stats-bar">
        <div class="quiz-stat-item">
          <div class="quiz-stat-num">${localStats.total}</div>
          <div class="quiz-stat-label">총 문제</div>
        </div>
        <div class="quiz-stat-item">
          <div class="quiz-stat-num" style="color:var(--green)">${localStats.correct}</div>
          <div class="quiz-stat-label">정답</div>
        </div>
        <div class="quiz-stat-item">
          <div class="quiz-stat-num" style="color:var(--primary)">${localStats.rate}%</div>
          <div class="quiz-stat-label">정답률</div>
        </div>
      </div>`;
  }

  area.innerHTML = `
    ${statsHtml}
    <div class="quiz-card">
      <div style="font-size:17px;font-weight:800;margin-bottom:16px">퀴즈 모드 선택</div>
      <div class="quiz-mode-btns">
        <button class="btn quiz-mode-btn ${quizMode === 'multiple' ? 'active' : ''}" onclick="setQuizMode('multiple')">
          객관식 (4지선다)
        </button>
        <button class="btn quiz-mode-btn ${quizMode === 'written' ? 'active' : ''}" onclick="setQuizMode('written')">
          주관식 (입력)
        </button>
        <button class="btn quiz-mode-btn ${quizMode === 'wrong' ? 'active' : ''}" onclick="setQuizMode('wrong')">
          틀린 단어만
        </button>
      </div>
      <div style="margin-top:16px">
        <button class="btn btn-blue" style="width:100%;padding:14px" onclick="startQuiz()">퀴즈 시작</button>
      </div>
    </div>`;
}

function setQuizMode(mode) {
  quizMode = mode;
  showQuizSetup();
}

function startQuiz() {
  const vocab = getVocab();
  quizResults = [];

  if (quizMode === 'wrong') {
    const wrongWords = getLocalWrongWords();
    quizList = vocab.filter(v => wrongWords.has(v.word.toLowerCase()));
    if (!quizList.length) {
      showToast('틀린 단어가 없습니다!');
      return;
    }
  } else {
    quizList = [...vocab];
  }

  quizList = quizList.sort(() => Math.random() - 0.5).slice(0, 20);
  quizIdx = 0;
  renderQuizQuestion();
}

function renderQuizQuestion() {
  if (quizIdx >= quizList.length) {
    showQuizResult();
    return;
  }

  const q   = quizList[quizIdx];
  const pct = Math.round((quizIdx / quizList.length) * 100);
  const area = document.getElementById('quizArea');

  if (quizMode === 'written' || (quizMode === 'wrong' && getVocab().length < 4)) {
    // 주관식
    area.innerHTML = `
      <div class="quiz-card">
        <div class="quiz-progress">${quizIdx + 1} / ${quizList.length}</div>
        <div class="quiz-progress-bar">
          <div class="quiz-progress-fill" style="width:${pct}%"></div>
        </div>
        <div class="quiz-word">${escHtml(q.word)}</div>
        <div class="quiz-hint">이 단어의 뜻을 입력하세요</div>
        <input type="text" id="quizInput" class="quiz-text-input" placeholder="한국어 뜻 입력"
               onkeydown="if(event.key==='Enter')checkWrittenAnswer()" />
        <div class="quiz-btns" style="margin-top:12px">
          <button class="btn btn-blue" onclick="checkWrittenAnswer()">확인</button>
        </div>
      </div>`;
    setTimeout(() => document.getElementById('quizInput')?.focus(), 100);
  } else {
    // 객관식
    const allVocab = getVocab();
    const wrongOptions = allVocab
      .filter(v => v.word !== q.word)
      .sort(() => Math.random() - 0.5)
      .slice(0, 3)
      .map(v => v.translation);
    const options = [q.translation, ...wrongOptions].sort(() => Math.random() - 0.5);

    area.innerHTML = `
      <div class="quiz-card">
        <div class="quiz-progress">${quizIdx + 1} / ${quizList.length}</div>
        <div class="quiz-progress-bar">
          <div class="quiz-progress-fill" style="width:${pct}%"></div>
        </div>
        <div class="quiz-word">${escHtml(q.word)}</div>
        <div class="quiz-hint">올바른 뜻을 선택하세요</div>
        <div class="quiz-options">
          ${options.map(opt => `
            <button class="quiz-option-btn" onclick="checkMultipleAnswer(this, '${escAttr(opt)}', '${escAttr(q.translation)}')">${escHtml(opt)}</button>
          `).join('')}
        </div>
      </div>`;
  }
}

function checkMultipleAnswer(_btn, selected, correct) {
  const q = quizList[quizIdx];
  const isCorrect = selected === correct;
  const buttons = document.querySelectorAll('.quiz-option-btn');

  buttons.forEach(b => {
    b.disabled = true;
    const val = b.textContent.trim();
    if (val === correct) b.classList.add('correct');
    if (val === selected && !isCorrect) b.classList.add('wrong');
  });

  quizResults.push({ word: q.word, translation: q.translation, correct: isCorrect });
  saveLocalQuizResult(q, isCorrect, 'MULTIPLE_CHOICE');

  if (getToken() && q.id) {
    apiRequest('POST', '/api/quiz/result', {
      vocabId: q.id, correct: isCorrect, quizType: 'MULTIPLE_CHOICE'
    }).catch(() => {});
  }

  setTimeout(() => { quizIdx++; renderQuizQuestion(); }, isCorrect ? 800 : 1500);
}

function checkWrittenAnswer() {
  const input = document.getElementById('quizInput');
  if (!input) return;
  const answer = input.value.trim();
  if (!answer) return;

  const q = quizList[quizIdx];
  const isCorrect = normalizeAnswer(answer) === normalizeAnswer(q.translation);

  const area = document.getElementById('quizArea');
  const card = area.querySelector('.quiz-card');
  const resultDiv = document.createElement('div');
  resultDiv.className = 'quiz-written-result';
  resultDiv.innerHTML = isCorrect
    ? `<div style="color:var(--green);font-weight:700;font-size:16px">정답!</div>`
    : `<div style="color:var(--red);font-weight:700;font-size:16px">오답</div>
       <div style="color:var(--sub);font-size:14px;margin-top:4px">정답: ${escHtml(q.translation)}</div>`;
  card.appendChild(resultDiv);
  input.disabled = true;

  quizResults.push({ word: q.word, translation: q.translation, correct: isCorrect });
  saveLocalQuizResult(q, isCorrect, 'WRITTEN');

  if (getToken() && q.id) {
    apiRequest('POST', '/api/quiz/result', {
      vocabId: q.id, correct: isCorrect, quizType: 'WRITTEN'
    }).catch(() => {});
  }

  setTimeout(() => { quizIdx++; renderQuizQuestion(); }, isCorrect ? 800 : 1500);
}

function normalizeAnswer(s) {
  return s.replace(/[\s,./!?~·]/g, '').toLowerCase();
}

function showQuizResult() {
  const correct = quizResults.filter(r => r.correct).length;
  const total = quizResults.length;
  const rate = total > 0 ? Math.round((correct / total) * 100) : 0;
  const wrongList = quizResults.filter(r => !r.correct);

  let wrongHtml = '';
  if (wrongList.length) {
    wrongHtml = `
      <div style="text-align:left;margin-top:16px">
        <div style="font-weight:700;margin-bottom:8px;font-size:13px">틀린 단어:</div>
        ${wrongList.map(w => `
          <div class="quiz-wrong-item">
            <span class="quiz-wrong-word">${escHtml(w.word)}</span>
            <span class="quiz-wrong-trans">${escHtml(w.translation)}</span>
          </div>
        `).join('')}
      </div>`;
  }

  document.getElementById('quizArea').innerHTML = `
    <div class="quiz-card">
      <div style="font-size:42px;margin-bottom:12px">${rate >= 80 ? '🎉' : rate >= 50 ? '💪' : '📚'}</div>
      <div style="font-size:17px;font-weight:800;margin-bottom:6px">퀴즈 완료!</div>
      <div class="quiz-result-stats">
        <span style="color:var(--green)">${correct}개 정답</span> /
        <span>${total}개</span> =
        <span style="font-weight:800;color:${rate >= 80 ? 'var(--green)' : rate >= 50 ? 'var(--primary)' : 'var(--red)'}">${rate}%</span>
      </div>
      ${wrongHtml}
      <div class="quiz-btns" style="margin-top:20px">
        ${wrongList.length ? `<button class="btn btn-red" onclick="quizMode='wrong';startQuiz()">틀린 단어만 다시</button>` : ''}
        <button class="btn btn-blue" onclick="showQuizSetup()">다시 시작</button>
      </div>
    </div>`;
}

/* ════════════════════════════════════════
   로컬 퀴즈 결과 관리
════════════════════════════════════════ */
function getLocalQuizResults() {
  return JSON.parse(localStorage.getItem('vocab_quiz_results') || '[]');
}

function saveLocalQuizResult(vocab, isCorrect, quizType) {
  const results = getLocalQuizResults();
  results.push({
    word: vocab.word,
    correct: isCorrect,
    type: quizType,
    date: new Date().toISOString()
  });
  // 최근 500개만 유지
  if (results.length > 500) results.splice(0, results.length - 500);
  localStorage.setItem('vocab_quiz_results', JSON.stringify(results));
}

function getLocalQuizStats() {
  const results = getLocalQuizResults();
  const total = results.length;
  const correct = results.filter(r => r.correct).length;
  const rate = total > 0 ? Math.round((correct / total) * 100) : 0;
  return { total, correct, rate };
}

function getLocalWrongWords() {
  const results = getLocalQuizResults();
  const wordMap = {};
  results.forEach(r => {
    if (!wordMap[r.word.toLowerCase()]) {
      wordMap[r.word.toLowerCase()] = { correct: 0, wrong: 0, lastWrongDate: null };
    }
    if (r.correct) {
      wordMap[r.word.toLowerCase()].correct++;
    } else {
      wordMap[r.word.toLowerCase()].wrong++;
      wordMap[r.word.toLowerCase()].lastWrongDate = r.date;
    }
  });

  const wrongSet = new Set();
  Object.entries(wordMap).forEach(([word, stats]) => {
    if (stats.wrong > stats.correct) wrongSet.add(word);
  });
  return wrongSet;
}

/* ════════════════════════════════════════
   Payment (토스페이먼츠)
════════════════════════════════════════ */
const TOSS_CLIENT_KEY = 'test_ck_pP2YxJ4K87zeRmWPJdGLrRGZwXLO'; // 실제 키로 교체 필요

function showPremiumBenefits() {
  document.getElementById('premiumModal').style.display = 'flex';
}

function closePremiumModal(e) {
  if (!e || e.target === e.currentTarget) {
    document.getElementById('premiumModal').style.display = 'none';
  }
}

async function showUpgradePrompt() {
  closePremiumModal();
  if (!getToken()) {
    showToast('로그인이 필요합니다.');
    return;
  }

  try {
    const statusRes = await apiRequest('GET', '/api/payment/status');
    const status = await statusRes.json();
    if (status.isPremium) {
      showToast('이미 프리미엄 회원입니다!');
      return;
    }
  } catch {}

  const plan = confirm('프리미엄 업그레이드\n\n평생 이용권: ₩6,900 (단 한 번 결제)\n연간 이용권: ₩4,900\n\n확인 = 평생 이용권 / 취소 = 연간 이용권')
    ? 'LIFETIME' : 'ANNUAL';

  try {
    const res = await apiRequest('POST', '/api/payment/request', { plan });
    if (!res.ok) throw new Error();
    const data = await res.json();

    if (typeof TossPayments === 'undefined') {
      showToast('결제 모듈을 로드 중입니다. 잠시 후 다시 시도해주세요.');
      return;
    }

    const tossPayments = TossPayments(TOSS_CLIENT_KEY);
    const currentUrl = window.location.href.split('?')[0];

    await tossPayments.requestPayment('카드', {
      amount: data.amount,
      orderId: data.orderId,
      orderName: data.orderName,
      successUrl: `${currentUrl}?payment=success`,
      failUrl: `${currentUrl}?payment=fail`
    });
  } catch (e) {
    if (e.code === 'USER_CANCEL') return;
    showToast('결제 요청 실패: ' + (e.message || ''));
  }
}

async function handlePaymentCallback() {
  const params = new URLSearchParams(window.location.search);

  if (params.get('payment') === 'success') {
    const paymentKey = params.get('paymentKey');
    const orderId = params.get('orderId');
    const amount = parseInt(params.get('amount'));

    if (paymentKey && orderId && amount) {
      try {
        const res = await apiRequest('POST', '/api/payment/confirm', {
          paymentKey, orderId, amount
        });
        if (res.ok) {
          showToast('프리미엄 업그레이드 완료!');
        } else {
          showToast('결제 승인 실패');
        }
      } catch {
        showToast('결제 승인 중 오류');
      }
    }
    window.history.replaceState({}, '', window.location.pathname);
  } else if (params.get('payment') === 'fail') {
    showToast('결제가 취소되었습니다.');
    window.history.replaceState({}, '', window.location.pathname);
  } else if (params.get('upgrade') === '1') {
    // 확장에서 "업그레이드" 클릭 시 웹앱 결제로 유도되는 진입점
    window.history.replaceState({}, '', window.location.pathname);
    showPremiumBenefits();
  }
}

// 페이지 로드 시 결제 콜백 처리
window.addEventListener('load', handlePaymentCallback);

/* ════════════════════════════════════════
   Helpers
════════════════════════════════════════ */
function getVocab()   { return JSON.parse(localStorage.getItem('vocab_en') || '[]'); }
function saveVocab(v) { localStorage.setItem('vocab_en', JSON.stringify(v)); }
function today()      { return new Date().toLocaleDateString('ko-KR'); }
function escHtml(s)   { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escAttr(s)   { return s.replace(/'/g, "\\'").replace(/"/g, '&quot;'); }

function updateBadge() {
  const el = document.getElementById('todayCount');
  if (el) el.textContent = getVocab().filter(v => v.date === today()).length;
  renderNav();
  if (activePane === 'library') {
    renderLibTabs();
    renderLibrary();
  }
}

let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

updateBadge();
