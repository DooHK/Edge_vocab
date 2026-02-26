/* ════════════════════════════════════════
   설정 (배포 후 변경)
════════════════════════════════════════ */
const API_BASE = 'https://edgevocabbackend-production.up.railway.app';
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
    document.getElementById('userInfo').style.display = 'block';
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
  updateBadge();
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

  // 플랜 상태 → 업그레이드 배너 + 플랜 표시
  try {
    const statusRes = await apiRequest('GET', '/api/payment/status');
    if (statusRes.ok) {
      const status = await statusRes.json();
      const banner = document.getElementById('upgradeBanner');
      const planLabel = document.getElementById('currentPlan');
      if (banner) banner.style.display = status.isPremium ? 'none' : 'flex';
      if (planLabel) planLabel.textContent = status.isPremium ? '프리미엄' : '무료';
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
   Tabs
════════════════════════════════════════ */
function switchTab(tab) {
  const names = ['translate', 'vocab', 'quiz'];
  document.querySelectorAll('.tab').forEach((t, i) =>
    t.classList.toggle('active', names[i] === tab)
  );
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-' + tab).classList.add('active');
  if (tab === 'vocab') { loadFolders(); renderVocab(); }
  if (tab === 'quiz')  showQuizSetup();
  if (tab === 'translate') document.getElementById('wordInput').focus();
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
  alreadyAdded = false;

  const btn     = document.getElementById('translateBtn');
  const loading = document.getElementById('loading');
  const card    = document.getElementById('resultCard');

  btn.disabled = true;
  loading.classList.add('show');
  card.classList.remove('show');

  try {
    let translated;

    if (getToken()) {
      // 로그인 사용자: 서버 Google Translate API
      const res = await apiRequest('POST', '/api/translate', {
        text: raw, source: 'en', target: 'ko'
      });

      if (res.status === 402) {
        showToast('월 무료 번역 한도를 초과했습니다. 프리미엄으로 업그레이드하세요!');
        btn.disabled = false;
        loading.classList.remove('show');
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
    document.getElementById('resultMeta').textContent = getToken() ? 'Google Translate' : 'MyMemory';

    const exists = getVocab().some(v => v.word.toLowerCase() === raw.toLowerCase());
    const addBtn = document.getElementById('addBtn');
    addBtn.textContent = exists ? '이미 추가됨' : '단어장에 추가';
    addBtn.className   = 'btn btn-add' + (exists ? ' added' : '');
    alreadyAdded = exists;

    card.classList.add('show');

    // 자동 추가
    if (!exists && localStorage.getItem('vocab_auto_add') === 'true') {
      await addToVocab();
    }
  } catch {
    showToast('네트워크 오류가 발생했습니다.');
  } finally {
    btn.disabled = false;
    loading.classList.remove('show');
  }
}

async function addToVocab() {
  if (alreadyAdded || !curWord) return;
  const vocab = getVocab();
  if (vocab.some(v => v.word.toLowerCase() === curWord.toLowerCase())) {
    showToast('이미 단어장에 있습니다.');
    return;
  }

  const newItem = { word: curWord, translation: curTrans, date: today() };

  if (getToken()) {
    try {
      // 일별 자동 폴더
      const dateFolder = await getOrCreateDateFolder(today());
      if (dateFolder) newItem.folderId = dateFolder.id;

      const res = await apiRequest('POST', '/api/vocab', {
        word: newItem.word, translation: newItem.translation,
        date: newItem.date, folderId: newItem.folderId
      });
      if (!res.ok) throw new Error();
      const saved = await res.json();
      newItem.id = saved.id;
      newItem.folderName = saved.folderName;
    } catch {
      showToast('서버 저장 실패. 로컬에만 저장됩니다.');
    }
  } else {
    newItem.folderName = today();
  }

  vocab.unshift(newItem);
  saveVocab(vocab);
  updateBadge();

  const addBtn = document.getElementById('addBtn');
  addBtn.textContent = '추가됨';
  addBtn.className   = 'btn btn-add added';
  alreadyAdded = true;
  showToast(`"${curWord}" 단어장에 추가!`);
}

/* ════════════════════════════════════════
   Folders
════════════════════════════════════════ */
let folders = [];
let selectedFolderId = null; // null = 전체, 0 = 미분류, -1 = 틀린 단어

async function loadFolders() {
  if (!getToken()) { folders = []; renderFolderChips(); return; }
  try {
    const res = await apiRequest('GET', '/api/folders');
    if (res.ok) folders = await res.json();
  } catch { folders = []; }
  renderFolderChips();
}

function renderFolderChips() {
  const container = document.getElementById('folderChips');
  if (!container) return;

  let html = `<span class="folder-chip${selectedFolderId === null ? ' active' : ''}" onclick="selectFolder(null)">전체</span>`;
  html += `<span class="folder-chip${selectedFolderId === 0 ? ' active' : ''}" onclick="selectFolder(0)">미분류</span>`;
  html += `<span class="folder-chip${selectedFolderId === -1 ? ' active' : ''}" onclick="selectFolder(-1)">틀린 단어</span>`;

  folders.forEach(f => {
    html += `<span class="folder-chip${selectedFolderId === f.id ? ' active' : ''}" onclick="selectFolder(${f.id})">${escHtml(f.name)} <small>(${f.wordCount})</small></span>`;
  });

  html += `<span class="folder-chip folder-chip-add" onclick="showCreateFolder()">+ 새 폴더</span>`;
  container.innerHTML = html;
}

function selectFolder(id) {
  selectedFolderId = id;
  renderFolderChips();
  renderVocab();
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
  if (!confirm('이 폴더를 삭제할까요? (단어는 미분류로 이동)')) return;
  try {
    await apiRequest('DELETE', `/api/folders/${folderId}`);
    if (selectedFolderId === folderId) selectedFolderId = null;
    await loadFolders();
    await syncFromServer();
    renderVocab();
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
    renderVocab();
    showToast('폴더 이동 완료');
  } catch {
    showToast('폴더 이동 실패');
  }
}

async function getOrCreateDateFolder(dateStr) {
  if (!getToken()) return null;

  const existing = folders.find(f => f.name === dateStr);
  if (existing) return existing;

  try {
    const res = await apiRequest('POST', '/api/folders', { name: dateStr });
    if (res.ok) {
      const folder = await res.json();
      folders.push(folder);
      return folder;
    }
  } catch {}
  return null;
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
  renderVocab();
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
  renderVocab();
  updateBadge();
  showToast('단어장을 비웠습니다.');
}

function renderVocab() {
  const query    = (document.getElementById('searchBox').value || '').toLowerCase();
  const allVocab = getVocab();

  let filtered = allVocab;

  if (selectedFolderId === 0) {
    // 미분류
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

  document.getElementById('vocabCount').textContent =
    `${allVocab.length}개 단어${selectedFolderId !== null || query ? ` (${filtered.length}개 표시)` : ''}`;

  const list = document.getElementById('vocabList');
  if (!filtered.length) {
    list.innerHTML = `<div class="empty-msg">
      <span class="empty-icon">${query ? '🔍' : '📭'}</span>
      ${query ? '검색 결과가 없습니다.' : selectedFolderId === -1 ? '틀린 단어가 없습니다!' : '아직 저장된 단어가 없어요.<br>번역 탭에서 단어를 추가해보세요!'}
    </div>`;
    return;
  }

  list.innerHTML = filtered.map(v => {
    const origIdx = allVocab.findIndex(x => x.word === v.word && x.date === v.date);
    const folderLabel = v.folderName ? `<span class="word-folder-tag">${escHtml(v.folderName)}</span>` : '';
    return `
      <div class="word-item">
        <div class="word-info">
          <div class="word-en-item">${escHtml(v.word)}</div>
          <div class="word-ko-item">${escHtml(v.translation)}</div>
          <div class="word-date-item">${v.date} ${folderLabel}</div>
        </div>
        <div class="word-actions">
          <button class="btn btn-red btn-sm" onclick="deleteWord(${origIdx})">삭제</button>
        </div>
      </div>`;
  }).join('');
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
    renderVocab();
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

async function showUpgradePrompt() {
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

  const plan = confirm('프리미엄 업그레이드\n\n월간: ₩2,900\n연간: ₩19,900 (할인)\n\n연간 플랜으로 결제하시겠습니까?\n(확인=연간, 취소=월간)')
    ? 'ANNUAL' : 'MONTHLY';

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
  const n = getVocab().length;
  document.getElementById('badge').textContent = n ? ` (${n})` : '';
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
