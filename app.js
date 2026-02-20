/* ════════════════════════════════════════
   설정 (배포 후 변경)
════════════════════════════════════════ */
const API_BASE = 'http://localhost:8080';          // ← 백엔드 서버 주소
const GOOGLE_CLIENT_ID = '669898971300-ojr91etm7jss7i7e8fn3b189bbpfkg1t.apps.googleusercontent.com'; // ← 변경

/* ════════════════════════════════════════
   PWA
════════════════════════════════════════ */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

let deferredInstall = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstall = e;
  document.getElementById('installBanner').style.display = 'flex';
});
window.addEventListener('appinstalled', () => {
  document.getElementById('installBanner').style.display = 'none';
});

function installApp() {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  deferredInstall.userChoice.then(() => { deferredInstall = null; });
}

/* ════════════════════════════════════════
   Google Sign-In 초기화
════════════════════════════════════════ */
window.addEventListener('load', () => {
  if (getToken()) {
    showAppWithUser();
  } else {
    showLoginOverlay();
  }

  // GSI 라이브러리 로드 후 초기화
  if (typeof google !== 'undefined' && google.accounts) {
    initGSI();
  } else {
    // GSI 스크립트가 아직 로드되지 않은 경우 대기
    const checkGSI = setInterval(() => {
      if (typeof google !== 'undefined' && google.accounts) {
        clearInterval(checkGSI);
        initGSI();
      }
    }, 100);
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
}

/* handleGoogleSignIn: GSI 콜백 (전역 함수여야 함) */
async function handleGoogleSignIn(response) {
  try {
    setSyncStatus('로그인 중...');
    const res = await fetch(`${API_BASE}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: response.credential })
    });

    if (!res.ok) throw new Error('서버 인증 실패');

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
   서버 동기화
════════════════════════════════════════ */
async function syncFromServer() {
  if (!getToken()) return;
  setSyncStatus('🔄 동기화 중...');
  try {
    const res = await apiRequest('GET', '/api/vocab');
    if (!res.ok) throw new Error();
    const serverList = await res.json();
    // 서버 데이터를 localStorage에 덮어씀 (서버가 진실의 원천)
    const vocab = serverList.map(v => ({
      id: v.id, word: v.word, translation: v.translation, date: v.date
    }));
    saveVocab(vocab);
    updateBadge();
    setSyncStatus('✓ 동기화됨');
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
  if (tab === 'vocab') renderVocab();
  if (tab === 'quiz')  initQuiz();
}

/* ════════════════════════════════════════
   Translation
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
    const url  = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(raw)}&langpair=en|ko`;
    const res  = await fetch(url);
    const data = await res.json();

    if (data.responseStatus === 200) {
      curTrans = data.responseData.translatedText;

      document.getElementById('resultEn').textContent = raw;
      document.getElementById('resultKo').textContent = curTrans;
      document.getElementById('resultMeta').textContent =
        `신뢰도 ${Math.round((data.responseData.match || 0) * 100)}%  ·  MyMemory 무료 API`;

      const exists = getVocab().some(v => v.word.toLowerCase() === raw.toLowerCase());
      const addBtn = document.getElementById('addBtn');
      addBtn.textContent = exists ? '이미 추가됨 ✓' : '단어장에 추가 +';
      addBtn.className   = 'btn btn-green' + (exists ? ' added' : '');
      alreadyAdded = exists;

      card.classList.add('show');
    } else {
      showToast('번역 실패. 다시 시도해주세요.');
    }
  } catch {
    showToast('네트워크 오류가 발생했습니다.');
  } finally {
    btn.disabled = false;
    loading.classList.remove('show');
  }
}

/* ════════════════════════════════════════
   Vocabulary CRUD
════════════════════════════════════════ */
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
      const res = await apiRequest('POST', '/api/vocab', newItem);
      if (!res.ok) throw new Error();
      const saved = await res.json();
      newItem.id = saved.id;
    } catch {
      showToast('서버 저장 실패. 로컬에만 저장됩니다.');
    }
  }

  vocab.unshift(newItem);
  saveVocab(vocab);
  updateBadge();

  const addBtn = document.getElementById('addBtn');
  addBtn.textContent = '추가됨 ✓';
  addBtn.className   = 'btn btn-green added';
  alreadyAdded = true;
  showToast(`"${curWord}" 단어장에 추가!`);
}

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
  const filtered = allVocab.filter(v =>
    v.word.toLowerCase().includes(query) || v.translation.includes(query)
  );

  document.getElementById('vocabCount').textContent =
    `${allVocab.length}개 단어${query ? ` (검색: ${filtered.length}개)` : ''}`;

  const list = document.getElementById('vocabList');
  if (!filtered.length) {
    list.innerHTML = `<div class="empty-msg">
      <span class="empty-icon">${query ? '🔍' : '📭'}</span>
      ${query ? '검색 결과가 없습니다.' : '아직 저장된 단어가 없어요.<br>번역 탭에서 단어를 추가해보세요!'}
    </div>`;
    return;
  }

  list.innerHTML = filtered.map(v => {
    const origIdx = allVocab.findIndex(x => x.word === v.word && x.date === v.date);
    return `
      <div class="word-item">
        <div class="word-info">
          <div class="word-en-item">${escHtml(v.word)}</div>
          <div class="word-ko-item">${escHtml(v.translation)}</div>
          <div class="word-date-item">${v.date}</div>
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
   Quiz
════════════════════════════════════════ */
let quizList = [], quizIdx = 0;

function initQuiz() {
  const vocab = getVocab();
  if (!vocab.length) {
    document.getElementById('quizArea').innerHTML =
      `<div class="quiz-empty">📚 단어장에 단어를 먼저 추가하세요!</div>`;
    return;
  }
  quizList = [...vocab].sort(() => Math.random() - 0.5);
  quizIdx  = 0;
  renderQuiz();
}

function renderQuiz() {
  if (quizIdx >= quizList.length) {
    document.getElementById('quizArea').innerHTML = `
      <div class="quiz-card">
        <div style="font-size:42px;margin-bottom:12px">🎉</div>
        <div style="font-size:17px;font-weight:800;margin-bottom:6px">퀴즈 완료!</div>
        <div style="font-size:13px;color:#aaa;margin-bottom:20px">${quizList.length}개 단어를 모두 풀었어요</div>
        <button class="btn btn-blue" onclick="initQuiz()">다시 시작</button>
      </div>`;
    return;
  }

  const q   = quizList[quizIdx];
  const pct = Math.round((quizIdx / quizList.length) * 100);
  document.getElementById('quizArea').innerHTML = `
    <div class="quiz-card">
      <div class="quiz-progress">${quizIdx + 1} / ${quizList.length}</div>
      <div class="quiz-progress-bar">
        <div class="quiz-progress-fill" style="width:${pct}%"></div>
      </div>
      <div class="quiz-word">${escHtml(q.word)}</div>
      <div class="quiz-hint">이 단어의 뜻은 무엇일까요?</div>
      <div class="quiz-answer" id="quizAnswer">${escHtml(q.translation)}</div>
      <div class="quiz-btns">
        <button class="btn btn-blue"  id="revealBtn" onclick="revealAnswer()">정답 보기</button>
        <button class="btn btn-green" id="nextBtn"   onclick="nextQuiz()" style="display:none">다음 →</button>
      </div>
    </div>`;
}

function revealAnswer() {
  document.getElementById('quizAnswer').classList.add('show');
  document.getElementById('revealBtn').style.display = 'none';
  document.getElementById('nextBtn').style.display   = 'inline-block';
}

function nextQuiz() { quizIdx++; renderQuiz(); }

/* ════════════════════════════════════════
   Helpers
════════════════════════════════════════ */
function getVocab()   { return JSON.parse(localStorage.getItem('vocab_en') || '[]'); }
function saveVocab(v) { localStorage.setItem('vocab_en', JSON.stringify(v)); }
function today()      { return new Date().toLocaleDateString('ko-KR'); }
function escHtml(s)   { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

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
