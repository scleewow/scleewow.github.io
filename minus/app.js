// Supabase 라이브러리와 config.js 는 boot() 안에서 불러옴
// (불러오다 실패하면 '불러오는 중'에서 멈추지 않고 원인을 화면에 보여주기 위해)
const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// ---------------------------------------------------------------------
// 설정 / 상수
// ---------------------------------------------------------------------
const LS_ROOM = 'ma_room_id';
const LS_NICK = 'ma_nickname';
const seenKey = (roomId) => `ma_seen_result_${roomId}`;

const POLL_MS = 5000;        // 실시간 이벤트를 놓쳤을 때를 위한 보조 새로고침
const TIME_OPTIONS = [0, 10, 15, 20, 30, 45, 60];

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');

let sb = null;

const S = {
  roomId: null,
  data: null,        // ma_get_state 결과
  skew: 0,           // 서버 시간 - 내 시간 (ms)
  channel: null,
  timers: [],
  refreshing: false,
  refreshAgain: false,
  busy: false,       // 버튼 연타 방지
  lastCardKey: null, // 카드 뒤집기 애니메이션용
  timeoutFor: null,  // 같은 마감 시간에 timeout 을 여러 번 부르지 않도록
};

// ---------------------------------------------------------------------
// 유틸
// ---------------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer;
function toast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = 'toast'; }, 2600);
}

function errMsg(e) {
  return e?.message || e?.error_description || '알 수 없는 오류가 발생했습니다';
}

async function rpc(name, args = {}) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw error;
  return data;
}

// 연속된 숫자를 묶음으로: [20,21,22,25] -> [[20,21,22],[25]]
function runsOf(cards) {
  const sorted = [...cards].map(Number).sort((a, b) => a - b);
  const runs = [];
  for (const c of sorted) {
    const last = runs[runs.length - 1];
    if (last && c === last[last.length - 1] + 1) last.push(c);
    else runs.push([c]);
  }
  return runs;
}
// 카드 점수: 묶음마다 가장 작은 절댓값만 계산 (음수로 반환)
const cardScore = (cards) => -runsOf(cards).reduce((sum, run) => sum + run[0], 0);

// 가져간 카드: 연속된 숫자는 겹쳐서 한 묶음으로 (맨 앞 카드만 점수에 들어감)
function runsHtml(cards) {
  if (!cards || cards.length === 0) return '<div class="empty">가져간 카드 없음</div>';
  return `<div class="runs">${runsOf(cards).map((run) =>
    `<span class="stack">${run.map((c, i) =>
      `<span class="mc ${i === 0 ? 'count' : ''}" style="z-index:${run.length - i}">-${c}</span>`).join('')}</span>`).join('')}</div>`;
}

const serverNow = () => Date.now() + S.skew;

function autoChips(n) {
  if (n <= 5) return 11;
  if (n === 6) return 9;
  return 7;
}

function joinUrl(code) {
  return `${location.origin}${location.pathname}?room=${encodeURIComponent(code)}`;
}

function qrSvg(text) {
  if (typeof window.qrcode !== 'function') return '';
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag(4, 0);
}

// ---------------------------------------------------------------------
// 시작
// ---------------------------------------------------------------------
function bootError(html) {
  app.innerHTML = `<div class="config-error">${html}</div>`;
}

async function boot() {
  let createClient, cfg;
  try {
    ({ createClient } = await import(SUPABASE_JS));
  } catch (e) {
    return bootError(`Supabase 라이브러리를 불러오지 못했어요.<br/>인터넷 연결을 확인해 주세요.<br/><br/>${esc(errMsg(e))}`);
  }
  try {
    cfg = await import('./config.js');
  } catch (e) {
    return bootError(`<code>config.js</code> 를 읽지 못했어요. 따옴표나 세미콜론이 빠졌는지 확인해 주세요.<br/><br/>${esc(errMsg(e))}`);
  }

  const url = String(cfg.SUPABASE_URL || '').trim();
  const key = String(cfg.SUPABASE_ANON_KEY || '').trim();
  if (!url || !key || url.includes('YOUR-PROJECT') || key.includes('YOUR-')) {
    return bootError(`Supabase 설정이 필요합니다.<br/><code>config.js</code> 에 프로젝트 URL과 anon key를 넣어 주세요.`);
  }
  try {
    sb = createClient(url, key);
  } catch (e) {
    return bootError(`Supabase URL 형식이 올바르지 않아요.<br/>예: <code>https://abcd1234.supabase.co</code><br/><br/>${esc(errMsg(e))}`);
  }

  // 닉네임만으로 쓰기 위한 익명 로그인 (새로고침해도 같은 ID 유지)
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    const { error } = await sb.auth.signInAnonymously();
    if (error) {
      app.innerHTML = `<div class="config-error">로그인에 실패했습니다.<br/>
        Supabase 대시보드에서 익명 로그인(Anonymous Sign-Ins)이 켜져 있는지 확인해 주세요.<br/><br/>${esc(errMsg(error))}</div>`;
      return;
    }
  }

  const params = new URLSearchParams(location.search);
  const qrCode = params.get('room');

  // 이전에 있던 방으로 복귀 (세션 유지)
  const saved = localStorage.getItem(LS_ROOM);
  if (saved) {
    try {
      const st = await rpc('ma_get_state', { p_room: saved });
      if (st.member && (!qrCode || st.room.code === qrCode)) {
        clearQuery();
        enterRoom(saved, st);
        return;
      }
      if (!st.member) localStorage.removeItem(LS_ROOM);
    } catch (e) {
      console.warn(e);
    }
  }
  showHome(qrCode);
}

function clearQuery() {
  if (location.search) history.replaceState(null, '', location.pathname);
}

// ---------------------------------------------------------------------
// 첫 화면: 방 만들기 / 입장
// ---------------------------------------------------------------------
function showHome(prefillCode = '') {
  S.sig = null;
  S.viewingResult = false;
  leaveChannel();
  S.roomId = null;
  S.data = null;
  const nick = localStorage.getItem(LS_NICK) || '';
  const fromQr = !!prefillCode;

  app.innerHTML = `
    <header class="brand">
      <div class="kicker">THE HMGenius</div>
      <h1><span class="minus">마이너스</span> 경매</h1>
      <p>마이너스 점수를 가장 적게 받는 사람이 승리합니다</p>
    </header>

    ${fromQr ? '' : `<section class="panel">
      <h2>방 만들기 (방장)</h2>
      <label class="field"><span>방 생성 인증키</span>
        <input id="hostKey" type="password" placeholder="방 생성 인증키 입력" autocomplete="off" />
      </label>
      <label class="field"><span>닉네임</span>
        <input id="hostNick" maxlength="12" placeholder="사용할 닉네임 (1~12자)" value="${fromQr ? '' : esc(nick)}" autocomplete="off" />
      </label>
      <button id="createBtn" class="gold block">새 방 만들기</button>
    </section>`}

    <section class="panel">
      <h2>게임 참가하기</h2>
      <label class="field"><span>닉네임</span>
        <input id="joinNick" maxlength="12" placeholder="사용할 닉네임 (1~12자)" value="${esc(nick)}" autocomplete="off" />
      </label>
      <label class="field"><span>방 번호</span>
        <input id="code" class="code-input" inputmode="numeric" maxlength="5" placeholder="방 번호"
               value="${esc(prefillCode)}" autocomplete="off" />
      </label>
      <button id="joinBtn" class="primary block">입장하기</button>
    </section>
  `;

  const $hostKey = document.getElementById('hostKey');
  const $hostNick = document.getElementById('hostNick');
  const $joinNick = document.getElementById('joinNick');
  const $code = document.getElementById('code');
  if (fromQr) { $joinNick.scrollIntoView({ block: 'center' }); $joinNick.focus(); }

  const readNick = ($el) => {
    const v = $el.value.trim();
    if (!v) { toast('닉네임을 입력해 주세요', true); $el.focus(); return null; }
    localStorage.setItem(LS_NICK, v);
    return v;
  };

  const create = guard(async () => {
    if (!$hostKey) return;
    const key = $hostKey.value.trim();
    if (!key) { toast('방 생성 인증키를 입력해 주세요', true); $hostKey.focus(); return; }
    const n = readNick($hostNick); if (!n) return;
    const roomId = await rpc('ma_create_room', { p_key: key, p_nickname: n });
    clearQuery();
    await enterRoom(roomId);
  });
  if ($hostKey) {
    document.getElementById('createBtn').onclick = create;
    $hostNick.onkeydown = (e) => { if (e.key === 'Enter') create(); };
  }

  const join = guard(async () => {
    const n = readNick($joinNick); if (!n) return;
    const code = $code.value.trim();
    if (!code) { toast('방 번호를 입력해 주세요', true); $code.focus(); return; }
    const roomId = await rpc('ma_join_room', { p_code: code, p_nickname: n });
    clearQuery();
    await enterRoom(roomId);
  });
  document.getElementById('joinBtn').onclick = join;
  $code.onkeydown = (e) => { if (e.key === 'Enter') join(); };
  $joinNick.onkeydown = (e) => { if (e.key === 'Enter') join(); };
}

// 버튼 연타 방지 + 에러 토스트
function guard(fn) {
  return async (...args) => {
    if (S.busy) return;
    S.busy = true;
    try { await fn(...args); }
    catch (e) { toast(errMsg(e), true); }
    finally { S.busy = false; }
  };
}

// ---------------------------------------------------------------------
// 방 접속 / 실시간 / 주기 작업
// ---------------------------------------------------------------------
async function enterRoom(roomId, initialState = null) {
  S.sig = null;
  leaveChannel();
  S.roomId = roomId;
  localStorage.setItem(LS_ROOM, roomId);

  S.channel = sb.channel(`ma:room:${roomId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'ma_rooms', filter: `id=eq.${roomId}` }, refresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'ma_players', filter: `room_id=eq.${roomId}` }, refresh)
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'ma_rooms' },
      (p) => { if (p.old?.id === roomId) refresh(); })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'ma_players' },
      (p) => { if (p.old?.room_id === roomId) refresh(); })
    .subscribe((status) => { if (status === 'SUBSCRIBED') refresh(); });

  S.timers.push(setInterval(() => refresh(), POLL_MS));
  S.timers.push(setInterval(() => tick(), 250));

  if (initialState) applyState(initialState);
  else await refresh();
}

function leaveChannel() {
  S.timers.forEach(clearInterval);
  S.timers = [];
  if (S.channel) { sb.removeChannel(S.channel); S.channel = null; }
}

// 상태 새로고침 (동시에 여러 번 불려도 한 번씩 순서대로)
async function refresh() {
  if (!S.roomId) return;
  if (S.refreshing) { S.refreshAgain = true; return; }
  S.refreshing = true;
  try {
    const st = await rpc('ma_get_state', { p_room: S.roomId });
    applyState(st);
  } catch (e) {
    console.warn(e);
  } finally {
    S.refreshing = false;
    if (S.refreshAgain) { S.refreshAgain = false; refresh(); }
  }
}

function applyState(st) {
  if (!S.roomId) return;
  if (!st.member) {
    const msg = st.banned ? '방장에 의해 강퇴되었습니다'
      : !st.exists ? '방이 삭제되었습니다'
      : '방에서 나왔습니다';
    localStorage.removeItem(LS_ROOM);
    showHome();
    toast(msg, st.banned);
    return;
  }
  S.skew = Date.parse(st.server_now) - Date.now();
  // 바뀐 게 없으면 화면을 다시 그리지 않음 (선택 상자 등이 닫히지 않도록)
  const sig = JSON.stringify([st.room, st.my_chips, st.players.map((p) => [p.user_id, p.nickname, p.seat, p.cards, p.chips])]);
  S.data = st;
  if (sig !== S.sig) {
    S.sig = sig;
    render();
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.roomId) refresh();
});

// 타이머 표시 + 시간 초과 처리
function tick() {
  const d = S.data;
  if (!d || d.room.status !== 'playing' || !d.room.turn_deadline) return;
  const deadline = Date.parse(d.room.turn_deadline);
  const total = (d.room.settings.turn_seconds || 1) * 1000;
  const left = deadline - serverNow();

  const bar = document.getElementById('timerBar');
  const txt = document.getElementById('timerText');
  if (bar) {
    const pct = Math.max(0, Math.min(100, (left / total) * 100));
    bar.firstElementChild.style.width = pct + '%';
    bar.classList.toggle('low', left < 5000);
  }
  if (txt) txt.textContent = left > 0 ? `${Math.ceil(left / 1000)}초 남음` : '시간 초과';

  // 마감이 지나면 아무나 서버에 처리 요청 (서버가 실제로 지났는지 다시 확인)
  if (left < -300 && S.timeoutFor !== d.room.turn_deadline) {
    S.timeoutFor = d.room.turn_deadline;
    sb.rpc('ma_timeout', { p_room: S.roomId }).then(() => refresh());
  }
}

// ---------------------------------------------------------------------
// 화면 그리기
// ---------------------------------------------------------------------
function render() {
  const { room } = S.data;
  if (room.status === 'playing') return renderGame();

  const seen = Number(localStorage.getItem(seenKey(room.id)) || 0);
  if (room.result && (room.result.game_no > seen || S.viewingResult)) return renderResult();
  S.viewingResult = false;
  renderLobby();
}

// ----- 대기실 -----
function renderLobby() {
  const { room, players, me } = S.data;
  const isHost = room.host_id === me;
  const s = room.settings;
  const n = players.length;
  const url = joinUrl(room.code);
  const autoLabel = `자동 (${autoChips(n)}개)`;

  const playerItems = players.map((p) => `
    <li>
      <span class="name">${esc(p.nickname)}</span>
      ${p.user_id === room.host_id ? '<span class="tag host">방장</span>' : ''}
      ${p.user_id === me ? '<span class="tag me">나</span>' : ''}
      ${isHost && p.user_id !== me
        ? `<button class="small danger" data-kick="${p.user_id}" data-name="${esc(p.nickname)}">강퇴</button>` : ''}
    </li>`).join('');

  const timeLabel = (t) => (t === 0 ? '제한 없음' : `${t}초`);

  const settingsHtml = isHost ? `
    <div class="settings-grid">
      <label class="field"><span>제외 카드 수</span>
        <select id="sExclude">${[1, 2, 3, 4, 5].map((v) =>
          `<option value="${v}" ${s.exclude_count === v ? 'selected' : ''}>${v}장</option>`).join('')}</select>
      </label>
      <label class="field"><span>시작 칩</span>
        <select id="sChips">
          <option value="" ${s.start_chips == null ? 'selected' : ''}>${autoLabel}</option>
          ${Array.from({ length: 30 }, (_, i) => i + 1).map((v) =>
            `<option value="${v}" ${s.start_chips === v ? 'selected' : ''}>${v}개</option>`).join('')}
        </select>
      </label>
      <label class="field"><span>칩 개수 공개</span>
        <select id="sShow">
          <option value="false" ${!s.show_chips ? 'selected' : ''}>비공개</option>
          <option value="true" ${s.show_chips ? 'selected' : ''}>공개</option>
        </select>
      </label>
      <label class="field"><span>차례 제한 시간</span>
        <select id="sTime">${TIME_OPTIONS.map((v) =>
          `<option value="${v}" ${s.turn_seconds === v ? 'selected' : ''}>${timeLabel(v)}</option>`).join('')}</select>
      </label>
    </div>` : `
    <div class="settings-view">
      <div><small>제외 카드 수</small><b>${s.exclude_count}장</b></div>
      <div><small>시작 칩</small><b>${s.start_chips == null ? autoLabel : s.start_chips + '개'}</b></div>
      <div><small>칩 개수 공개</small><b>${s.show_chips ? '공개' : '비공개'}</b></div>
      <div><small>차례 제한 시간</small><b>${timeLabel(s.turn_seconds)}</b></div>
    </div>`;

  app.innerHTML = `
    <section class="panel">
      <div class="room-head">
        <div class="qr" title="${esc(url)}">${qrSvg(url)
          || '<div style="color:#555;font-size:11px;padding:30px 6px;text-align:center">QR을 불러오지 못했어요.<br/>방 번호로 입장해 주세요</div>'}</div>
        <div class="info">
          <div class="room-code-label">방 번호</div>
          <div class="room-code">${esc(room.code)}</div>
          <div class="count-badge">입장 <b>${n}</b>명</div>
          <div class="spacer"></div>
          <button id="copyBtn" class="small ghost">입장 링크 복사</button>
        </div>
      </div>
    </section>

    <section class="panel">
      <h2>참가자</h2>
      <ul class="players">${playerItems}</ul>
    </section>

    <section class="panel">
      <h2>게임 설정${isHost ? '' : ' (방장이 설정)'}</h2>
      ${settingsHtml}
    </section>

    <div class="actions">
      ${isHost ? `
        <button id="startBtn" class="primary block" ${n < 2 ? 'disabled' : ''}>
          ${n < 2 ? '2명 이상 모이면 시작할 수 있어요' : '게임 시작'}
        </button>` : '<div class="panel" style="text-align:center;color:var(--muted)">방장이 게임을 시작하길 기다리는 중…</div>'}
      ${room.result ? '<button id="lastResultBtn" class="ghost block">지난 게임 결과 보기</button>' : ''}
      ${isHost
        ? '<button id="deleteBtn" class="danger block">방 삭제</button>'
        : '<button id="leaveBtn" class="ghost block">나가기</button>'}
    </div>
  `;

  document.getElementById('copyBtn').onclick = async () => {
    try { await navigator.clipboard.writeText(url); toast('입장 링크를 복사했어요'); }
    catch { toast(url); }
  };

  app.querySelectorAll('[data-kick]').forEach((btn) => {
    btn.onclick = guard(async () => {
      if (!confirm(`${btn.dataset.name} 님을 강퇴할까요?\n강퇴된 플레이어는 이 방에 다시 들어올 수 없습니다.`)) return;
      await rpc('ma_kick_player', { p_room: room.id, p_target: btn.dataset.kick });
      await refresh();
    });
  });

  if (isHost) {
    const save = guard(async () => {
      const chips = document.getElementById('sChips').value;
      await rpc('ma_update_settings', {
        p_room: room.id,
        p_settings: {
          exclude_count: Number(document.getElementById('sExclude').value),
          start_chips: chips === '' ? null : Number(chips),
          show_chips: document.getElementById('sShow').value === 'true',
          turn_seconds: Number(document.getElementById('sTime').value),
        },
      });
      await refresh();
    });
    ['sExclude', 'sChips', 'sShow', 'sTime'].forEach((id) => { document.getElementById(id).onchange = save; });

    document.getElementById('startBtn').onclick = guard(async () => {
      await rpc('ma_start_game', { p_room: room.id });
      await refresh();
    });
    document.getElementById('deleteBtn').onclick = guard(async () => {
      if (!confirm('방을 삭제할까요?\n모든 플레이어가 방에서 나가게 됩니다.')) return;
      await rpc('ma_delete_room', { p_room: room.id });
      localStorage.removeItem(LS_ROOM);
      showHome();
      toast('방을 삭제했어요');
    });
  } else {
    document.getElementById('leaveBtn').onclick = guard(async () => {
      if (!confirm('방에서 나갈까요?')) return;
      await rpc('ma_leave_room', { p_room: room.id });
      localStorage.removeItem(LS_ROOM);
      showHome();
    });
  }

  const lastBtn = document.getElementById('lastResultBtn');
  if (lastBtn) lastBtn.onclick = () => { S.viewingResult = true; renderResult(); };
}

// ----- 게임 -----
function renderGame() {
  const { room, players, me, my_chips: myChips } = S.data;
  const s = room.settings;
  const order = players.filter((p) => p.seat !== null).sort((a, b) => a.seat - b.seat);
  const turnId = room.turn_order[room.turn_index];
  const turnPlayer = order.find((p) => p.user_id === turnId);
  const myTurn = turnId === me;

  // 카드가 바뀔 때만 뒤집기 애니메이션
  const cardKey = `${room.game_no}:${room.current_card}`;
  const animate = cardKey !== S.lastCardKey;
  S.lastCardKey = cardKey;

  const seats = order.map((p) => {
    const isMe = p.user_id === me;
    const chips = isMe ? myChips : (s.show_chips ? p.chips : '?');
    const score = cardScore(p.cards);
    return `
      <div class="seat ${p.user_id === turnId ? 'turn' : ''} ${isMe ? 'me' : ''}">
        <div class="seat-head">
          <span class="order">${p.seat + 1}</span>
          <span class="name">${esc(p.nickname)}${isMe ? ' (나)' : ''}</span>
          <span class="stat chips"><span class="chip-dot small"></span><b>${chips}</b></span>
          <span class="stat">카드 <b>${score}</b></span>
          ${isMe ? `<span class="stat total">총점 <b>${score + myChips}</b></span>` : ''}
        </div>
        ${runsHtml(p.cards)}
      </div>`;
  }).join('');

  app.innerHTML = `
    <div class="game-top">
      <span>방 <b>${esc(room.code)}</b></span>
      <span>남은 카드 <b>${room.deck_count}</b>장 · 제외 <b>${s.exclude_count}</b>장</span>
    </div>

    <section class="stage-row">
      <div class="stage-card">
        <div class="big-card" style="${animate ? '' : 'animation:none'}">-${room.current_card}</div>
        <div class="pot">
          <span class="pot-chips">${Array.from({ length: Math.min(room.pot, 8) }, () => '<span class="chip-dot small"></span>').join('')}</span>
          <span>쌓인 칩 <b>${room.pot}</b></span>
        </div>
      </div>
      <div class="stage-side">
        <div class="turn-banner ${myTurn ? 'mine' : ''}">
          ${myTurn ? '내 차례입니다' : `${esc(turnPlayer?.nickname ?? '')} 님 차례`}
        </div>
        ${room.turn_deadline ? `
          <div id="timerBar" class="timer"><i style="width:100%"></i></div>
          <div id="timerText" class="timer-text"></div>` : ''}
        ${myTurn ? `
          <div class="act-col">
            <button id="takeBtn" class="primary">가져가기<small>칩 ${room.pot}개 획득</small></button>
            <button id="passBtn" class="secondary" ${myChips <= 0 ? 'disabled' : ''}>
              거부<small>${myChips <= 0 ? '칩이 없어요' : '칩 1개 내기'}</small>
            </button>
          </div>` : ''}
      </div>
    </section>

    <section>
      <h2 class="section-title">순서</h2>
      ${seats}
    </section>

    ${room.host_id === me ? `
      <div class="spacer"></div>
      <button id="forceEndBtn" class="danger block">게임 강제 종료</button>` : ''}
  `;

  const forceBtn = document.getElementById('forceEndBtn');
  if (forceBtn) {
    forceBtn.onclick = guard(async () => {
      if (!confirm('게임을 강제 종료할까요?\n모든 플레이어가 대기실로 돌아갑니다.')) return;
      await rpc('ma_force_end', { p_room: room.id });
      await refresh();
    });
  }

  if (myTurn) {
    document.getElementById('passBtn').onclick = guard(async () => {
      await rpc('ma_pass', { p_room: room.id });
      await refresh();
    });
    document.getElementById('takeBtn').onclick = guard(async () => {
      await rpc('ma_take', { p_room: room.id });
      await refresh();
    });
  }
  tick();
}

// ----- 결과 -----
function renderResult() {
  const { room, me } = S.data;
  const r = room.result;
  const list = r.players || [];

  const ranks = list.map((p, i) => `
    <div class="rank ${i === 0 ? 'first' : ''} ${i === list.length - 1 && list.length > 1 ? 'last' : ''}">
      <div class="pos">${i + 1}</div>
      <div class="body">
        <div class="who">${esc(p.nickname)}${p.user_id === me ? ' (나)' : ''}
          ${i === 0 && !r.aborted ? '<span class="tag host">승자</span>' : ''}
          ${i === list.length - 1 && list.length > 1 && !r.aborted ? '<span class="tag">패자</span>' : ''}</div>
        <div class="detail">카드 ${p.card_score} · 칩 +${p.chips}</div>
        ${runsHtml(p.cards)}
      </div>
      <div class="total">${p.total}</div>
    </div>`).join('');

  app.innerHTML = `
    <header class="result-title">
      <div class="kicker">GAME ${r.game_no}</div>
      <h1>${r.aborted ? '게임 강제 종료' : '최종 결과'}</h1>
    </header>

    ${r.aborted ? `<div class="aborted">${esc(r.reason)}</div>` : ''}

    <section class="panel">
      <h2>순위</h2>
      ${ranks || '<div class="empty">기록 없음</div>'}
    </section>

    <section class="panel">
      <h2>히든 카드 (제외된 카드)</h2>
      <div class="hidden-cards">${(r.excluded || []).map((c) => `<div class="mini-card">-${c}</div>`).join('')}</div>
    </section>

    <button id="backBtn" class="gold block">대기실로 돌아가기</button>
  `;

  document.getElementById('backBtn').onclick = () => {
    localStorage.setItem(seenKey(room.id), String(r.game_no));
    S.viewingResult = false;
    renderLobby();
  };
}

boot().catch((e) => {
  console.error(e);
  bootError(`시작하는 중 오류가 났어요.<br/><br/>${esc(errMsg(e))}`);
});
