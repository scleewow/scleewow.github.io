// =====================================================================
// 충신과 역적 (/loyal)
// 서버: loyal/schema.sql (Supabase RPC) · 채팅: shared/team-chat.js
// =====================================================================
import { mountTeamChat } from '../shared/team-chat.js';

const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const LS_ROOM = 'lr_room_id';
const LS_NICK = 'lr_nickname';
const roleSeenKey = (roomId, gameNo) => `lr_role_seen_${roomId}_${gameNo}`;

const POLL_MS = 4000;
const TURN_OPTIONS = [0, 10, 20, 30, 45, 60, 90, 120];
const VOTE_OPTIONS = [0, 10, 20, 30, 60, 90, 120];
const JAIL_OPTIONS = [0, 10, 20, 30, 60, 90, 120, 180];
const MIN_PLAYERS = 7;
const MAX_PLAYERS = 12;
const CELLS = 15;

const app = document.getElementById('app');
const sheetRoot = document.getElementById('sheet');
const chatRoot = document.getElementById('chatSheet');
const toastEl = document.getElementById('toast');

let sb = null;

const S = {
  roomId: null,
  data: null,
  sig: null,
  skew: 0,
  channel: null,
  timers: [],
  refreshing: false,
  refreshAgain: false,
  busy: false,
  timeoutFor: null,
  sheet: null,          // { type: 'turn' | 'vote' | 'jail' | 'role' | 'log' | 'help' }
  autoOpened: new Set(),
  compose: { key: null, picks: [], col: null },
  voteSel: null,
  jailSel: [],
  chat: null,           // 게임 중 역적 밀담
  chatKey: null,
  chatUnseen: 0,
  resultChat: null,
  viewingResult: false,
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
  return e?.message || e?.error_description || '알 수 없는 오류가 발생했어요';
}

async function rpc(name, args = {}) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw error;
  return data;
}

function guard(fn) {
  return async (...args) => {
    if (S.busy) return;
    S.busy = true;
    try { await fn(...args); }
    catch (e) { toast(errMsg(e), true); }
    finally { S.busy = false; }
  };
}

const serverNow = () => Date.now() + S.skew;

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

const timeLabel = (t) => (t === 0 ? '무제한' : `${t}초`);

const ICON = {
  crown: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M3 18h18l-2-10-5 4-2-6-2 6-5-4z"/></svg>',
  jail: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 4v16M10 4v16M15 4v16M20 4v16M3 4h18M3 20h18"/></svg>',
  clock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M10 2h4"/></svg>',
  close: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

// ---------------------------------------------------------------------
// 숫자 규칙 (서버 lr_candidates 와 동일)
// ---------------------------------------------------------------------
const lastOf = (col) => (col.length ? Number(col[col.length - 1].n) : 0);
// 1000을 넘은 것으로 보는 수: 1000 초과, 또는 15번째 칸이 아닌 곳의 1000 (서버 lr_is_over 와 동일)
const isOver = (n, cell) => n > 1000 || (n === 1000 && cell < CELLS);
const maxLenAfter = (last) => (last === 0 ? 1 : String(last).length + 1);

function candidates(digits, last) {
  const out = new Set();
  const maxLen = maxLenAfter(last);
  const walk = (used, str) => {
    if (str.length > 0) {
      const n = Number(str);
      if (n > last && str.length <= maxLen) out.add(n);
    }
    if (str.length >= Math.min(4, maxLen)) return;
    digits.forEach((d, i) => {
      if (used.includes(i)) return;
      if (str.length === 0 && d === 0) return;
      walk([...used, i], str + d);
    });
  };
  walk([], '');
  return out;
}

function minValid(digits, col) {
  if (col.length >= CELLS) return null;
  const c = candidates(digits, lastOf(col));
  return c.size ? Math.min(...c) : null;
}

// 지금 만든 수를 이 열에 낼 수 있는지 (불가하면 이유를 반환)
function colReason(numStr, col) {
  if (col.length >= CELLS) return '가득 찼어요';
  if (!numStr) return '숫자를 골라 주세요';
  const last = lastOf(col);
  const n = Number(numStr);
  if (numStr.length > maxLenAfter(last)) {
    return last === 0 ? '첫 칸은 한 자리만' : '자릿수 초과';
  }
  if (n <= last) return '직전보다 작음';
  return null;
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
    cfg = await import('../minus/config.js');
  } catch (e) {
    return bootError(`<code>minus/config.js</code> 를 읽지 못했어요.<br/><br/>${esc(errMsg(e))}`);
  }
  const url = String(cfg.SUPABASE_URL || '').trim();
  const key = String(cfg.SUPABASE_ANON_KEY || '').trim();
  if (!url || !key) return bootError('Supabase 설정이 필요해요. <code>minus/config.js</code> 를 확인해 주세요.');
  try {
    sb = createClient(url, key);
  } catch (e) {
    return bootError(`Supabase URL 형식이 올바르지 않아요.<br/><br/>${esc(errMsg(e))}`);
  }

  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    const { error } = await sb.auth.signInAnonymously();
    if (error) {
      return bootError(`로그인에 실패했어요.<br/>Supabase 대시보드에서 익명 로그인(Anonymous Sign-Ins)이 켜져 있는지 확인해 주세요.<br/><br/>${esc(errMsg(error))}`);
    }
  }

  const qrCode = new URLSearchParams(location.search).get('room');
  const saved = localStorage.getItem(LS_ROOM);
  if (saved) {
    try {
      const st = await rpc('lr_get_state', { p_room: saved });
      if (st.member && (!qrCode || st.room.code === qrCode)) {
        clearQuery();
        await enterRoom(saved, st);
        return;
      }
      if (!st.member) localStorage.removeItem(LS_ROOM);
    } catch (e) {
      console.warn(e);
      if (/function .*lr_get_state|Could not find the function/i.test(errMsg(e))) {
        return bootError('서버에 <code>loyal/schema.sql</code> 이 아직 적용되지 않은 것 같아요.');
      }
    }
  }
  showHome(qrCode);
}

function clearQuery() {
  if (location.search) history.replaceState(null, '', location.pathname);
}

// ---------------------------------------------------------------------
// 첫 화면
// ---------------------------------------------------------------------
function showHome(prefillCode = '') {
  app.classList.remove('game-mode', 'in-jail');
  leaveRoom();
  const nick = localStorage.getItem(LS_NICK) || localStorage.getItem('ma_nickname') || '';
  const fromQr = !!prefillCode;

  app.innerHTML = `
    <div class="help-row"><button class="pill-btn" data-help>게임 설명</button></div>
    <header class="brand">
      <div class="kicker">THE GENIUS</div>
      <h1>충신과 <span class="rebel">역적</span></h1>
      <p>충신은 1000을 지키고, 역적은 1000을 넘겨라</p>
    </header>

    ${fromQr ? '' : `<section class="panel">
      <h2>방 만들기 (방장)</h2>
      <label class="field"><span>방 생성 인증키</span>
        <input id="hostKey" type="password" placeholder="방 생성 인증키 입력" autocomplete="off" />
      </label>
      <label class="field"><span>닉네임</span>
        <input id="hostNick" maxlength="12" placeholder="사용할 닉네임 (1~12자)" value="${esc(nick)}" autocomplete="off" />
      </label>
      <button id="createBtn" class="btn primary block">새 방 만들기</button>
    </section>`}

    <section class="panel">
      <h2>게임 참가하기</h2>
      <label class="field"><span>닉네임</span>
        <input id="joinNick" maxlength="12" placeholder="사용할 닉네임 (1~12자)" value="${esc(nick)}" autocomplete="off" />
      </label>
      <label class="field"><span>방 번호</span>
        <input id="code" class="code-input" inputmode="numeric" maxlength="4" placeholder="0000" value="${esc(prefillCode)}" autocomplete="off" />
      </label>
      <button id="joinBtn" class="btn dark block">입장하기</button>
    </section>
  `;

  const $hostKey = document.getElementById('hostKey');
  const $hostNick = document.getElementById('hostNick');
  const $joinNick = document.getElementById('joinNick');
  const $code = document.getElementById('code');
  if (fromQr) $joinNick.focus();

  const readNick = ($el) => {
    const v = $el.value.trim();
    if (!v) { toast('닉네임을 입력해 주세요', true); $el.focus(); return null; }
    localStorage.setItem(LS_NICK, v);
    return v;
  };

  if ($hostKey) {
    const create = guard(async () => {
      const key = $hostKey.value.trim();
      if (!key) { toast('방 생성 인증키를 입력해 주세요', true); $hostKey.focus(); return; }
      const n = readNick($hostNick); if (!n) return;
      const roomId = await rpc('lr_create_room', { p_key: key, p_nickname: n });
      clearQuery();
      await enterRoom(roomId);
    });
    document.getElementById('createBtn').onclick = create;
    $hostNick.onkeydown = (e) => { if (e.key === 'Enter') create(); };
  }

  $code.oninput = () => { $code.value = $code.value.replace(/\D/g, '').slice(0, 4); };
  const join = guard(async () => {
    const n = readNick($joinNick); if (!n) return;
    const code = $code.value.trim();
    if (!code) { toast('방 번호를 입력해 주세요', true); $code.focus(); return; }
    const roomId = await rpc('lr_join_room', { p_code: code, p_nickname: n });
    clearQuery();
    await enterRoom(roomId);
  });
  document.getElementById('joinBtn').onclick = join;
  $code.onkeydown = (e) => { if (e.key === 'Enter') join(); };
  $joinNick.onkeydown = (e) => { if (e.key === 'Enter') join(); };
}

// ---------------------------------------------------------------------
// 방 접속 / 실시간
// ---------------------------------------------------------------------
async function enterRoom(roomId, initialState = null) {
  leaveRoom();
  S.roomId = roomId;
  localStorage.setItem(LS_ROOM, roomId);

  S.channel = sb.channel(`lr:${roomId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'lr_signal', filter: `room_id=eq.${roomId}` }, () => refresh())
    .subscribe((status) => { if (status === 'SUBSCRIBED') refresh(); });

  S.timers.push(setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, POLL_MS));
  S.timers.push(setInterval(tick, 250));

  if (initialState) applyState(initialState);
  else await refresh();
}

function leaveRoom() {
  S.timers.forEach(clearInterval);
  S.timers = [];
  if (S.channel) { sb.removeChannel(S.channel); S.channel = null; }
  closeChat(true);
  destroyResultChat();
  S.roomId = null;
  S.data = null;
  S.sig = null;
  S.sheet = null;
  S.viewingResult = false;
  renderSheet();
}

async function refresh() {
  if (!S.roomId) return;
  if (S.refreshing) { S.refreshAgain = true; return; }
  S.refreshing = true;
  try {
    const st = await rpc('lr_get_state', { p_room: S.roomId });
    applyState(st);
  } catch (e) {
    console.warn(e);
  } finally {
    S.refreshing = false;
    if (S.refreshAgain) { S.refreshAgain = false; refresh(); }
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.roomId) refresh();
});

function applyState(st) {
  if (!S.roomId) return;
  if (!st.member) {
    const msg = st.banned ? '방장에 의해 강퇴되었어요'
      : !st.exists ? '방이 삭제되었어요'
      : '방에서 나왔어요';
    localStorage.removeItem(LS_ROOM);
    showHome();
    toast(msg, !!st.banned);
    return;
  }
  S.skew = Date.parse(st.server_now) - Date.now();
  const { server_now: _ignored, ...rest } = st;
  const sig = JSON.stringify(rest);
  S.data = st;
  if (sig === S.sig) return;
  S.sig = sig;
  syncChat();
  autoSheets();
  render();
  renderSheet();
}

// ---------------------------------------------------------------------
// 타이머 / 시간 초과
// ---------------------------------------------------------------------
function phaseSeconds(room) {
  const s = room.settings || {};
  if (room.phase === 'turn') return s.turn_seconds || 0;
  if (room.phase === 'vote') return s.vote_seconds || 0;
  if (room.phase === 'jail') return s.jail_seconds || 0;
  return 0;
}

function tick() {
  const d = S.data;
  if (!d || d.room.status !== 'playing' || !d.room.deadline) return;
  const deadline = Date.parse(d.room.deadline);
  const total = Math.max(1, phaseSeconds(d.room)) * 1000;
  const left = deadline - serverNow();
  const secs = Math.max(0, Math.ceil(left / 1000));

  document.querySelectorAll('[data-timer]').forEach((el) => {
    el.lastElementChild.textContent = left > 0 ? `${secs}초` : '0초';
    el.classList.toggle('low', left < 10000);
  });
  document.querySelectorAll('[data-timebar]').forEach((el) => {
    el.firstElementChild.style.width = `${Math.max(0, Math.min(100, (left / total) * 100))}%`;
  });

  if (left < -300 && S.timeoutFor !== d.room.deadline) {
    S.timeoutFor = d.room.deadline;
    sb.rpc('lr_timeout', { p_room: S.roomId }).then(() => refresh());
  }
}

const timerPill = (room) => (room.deadline
  ? `<span class="timer-pill" data-timer>${ICON.clock}<span></span></span>` : '');

// ---------------------------------------------------------------------
// 화면 분기
// ---------------------------------------------------------------------
function render() {
  const { room } = S.data;
  if (room.status === 'playing') return renderGame();
  app.classList.remove('game-mode', 'in-jail');
  if (room.status === 'ended') return renderResult(false);
  if (S.viewingResult && room.result) return renderResult(true);
  destroyResultChat();
  renderLobby();
}

const nickOf = (uid) => S.data.players.find((p) => p.user_id === uid)?.nickname ?? '?';

// ----- 대기실 -----
function renderLobby() {
  const { room, players, me } = S.data;
  const isHost = room.host_id === me;
  const s = room.settings;
  const n = players.length;
  const url = joinUrl(room.code);
  const canStart = n >= MIN_PLAYERS && n <= MAX_PLAYERS;
  const rebels = Math.floor(n / 3);

  const items = players.map((p) => `
    <li>
      <span class="name">${esc(p.nickname)}</span>
      ${p.user_id === room.host_id ? '<span class="tag host">방장</span>' : ''}
      ${p.user_id === me ? '<span class="tag me">나</span>' : ''}
      ${isHost && p.user_id !== me
        ? `<button class="btn danger small" data-kick="${p.user_id}" data-name="${esc(p.nickname)}">강퇴</button>` : ''}
    </li>`).join('');

  const sel = (id, opts, v) => `<select id="${id}">${opts.map((o) =>
    `<option value="${o}" ${v === o ? 'selected' : ''}>${timeLabel(o)}</option>`).join('')}</select>`;

  const settings = isHost ? `
    <div class="settings-grid">
      <label class="field"><span>숫자 제출</span>${sel('sTurn', TURN_OPTIONS, s.turn_seconds)}</label>
      <label class="field"><span>왕 투표</span>${sel('sVote', VOTE_OPTIONS, s.vote_seconds)}</label>
      <label class="field"><span>감옥 지정</span>${sel('sJail', JAIL_OPTIONS, s.jail_seconds)}</label>
    </div>` : `
    <div class="settings-view">
      <div><small>숫자 제출</small><b>${timeLabel(s.turn_seconds)}</b></div>
      <div><small>왕 투표</small><b>${timeLabel(s.vote_seconds)}</b></div>
      <div><small>감옥 지정</small><b>${timeLabel(s.jail_seconds)}</b></div>
    </div>`;

  app.innerHTML = `
    <div class="help-row"><button class="pill-btn" data-help>게임 설명</button></div>
    <section class="panel">
      <div class="room-head">
        <div class="qr" title="${esc(url)}">${qrSvg(url) || '<div class="note" style="padding:28px 4px;text-align:center">QR을 불러오지 못했어요</div>'}</div>
        <div class="room-info">
          <div class="room-code-label">방 번호</div>
          <div class="room-code">${esc(room.code)}</div>
          <div class="note">입장 <b>${n}</b>명 · 7~12명</div>
          <div class="spacer"></div>
          <button id="copyBtn" class="btn quiet small">입장 링크 복사</button>
        </div>
      </div>
    </section>

    <section class="panel">
      <h2>참가자</h2>
      <ul class="players">${items}</ul>
      <p class="note">${canStart
        ? `이 인원이면 역적은 <b>${rebels}명</b>이에요.`
        : `${n < MIN_PLAYERS ? `${MIN_PLAYERS - n}명 더 모이면` : '인원이 너무 많아요. 12명 이하일 때'} 시작할 수 있어요.`}</p>
    </section>

    <section class="panel">
      <h2>제한 시간${isHost ? '' : ' (방장이 설정)'}</h2>
      ${settings}
      <p class="note">시간이 지나면 숫자는 가장 작은 수로 자동 제출, 투표는 기권, 감옥은 랜덤 2명으로 처리돼요.</p>
    </section>

    <div class="actions">
      ${isHost
        ? `<button id="startBtn" class="btn primary block" ${canStart ? '' : 'disabled'}>게임 시작</button>`
        : '<div class="panel" style="text-align:center;color:var(--muted)">방장이 게임을 시작하길 기다리는 중…</div>'}
      ${room.result ? '<button id="lastResultBtn" class="btn quiet block">지난 게임 결과 보기</button>' : ''}
      ${isHost
        ? '<button id="deleteBtn" class="btn danger block">방 삭제</button>'
        : '<button id="leaveBtn" class="btn quiet block">나가기</button>'}
    </div>
  `;

  document.getElementById('copyBtn').onclick = async () => {
    try { await navigator.clipboard.writeText(url); toast('입장 링크를 복사했어요'); }
    catch { toast(url); }
  };

  app.querySelectorAll('[data-kick]').forEach((btn) => {
    btn.onclick = guard(async () => {
      if (!confirm(`${btn.dataset.name} 님을 강퇴할까요?\n강퇴된 플레이어는 이 방에 다시 들어올 수 없어요.`)) return;
      await rpc('lr_kick_player', { p_room: room.id, p_target: btn.dataset.kick });
      await refresh();
    });
  });

  if (isHost) {
    const save = guard(async () => {
      await rpc('lr_update_settings', {
        p_room: room.id,
        p_settings: {
          turn_seconds: Number(document.getElementById('sTurn').value),
          vote_seconds: Number(document.getElementById('sVote').value),
          jail_seconds: Number(document.getElementById('sJail').value),
        },
      });
      await refresh();
    });
    ['sTurn', 'sVote', 'sJail'].forEach((id) => { document.getElementById(id).onchange = save; });

    document.getElementById('startBtn').onclick = guard(async () => {
      await rpc('lr_start_game', { p_room: room.id });
      await refresh();
    });
    document.getElementById('deleteBtn').onclick = guard(async () => {
      if (!confirm('방을 삭제할까요?\n모든 플레이어가 방에서 나가게 돼요.')) return;
      await rpc('lr_delete_room', { p_room: room.id });
      localStorage.removeItem(LS_ROOM);
      showHome();
      toast('방을 삭제했어요');
    });
  } else {
    document.getElementById('leaveBtn').onclick = guard(async () => {
      if (!confirm('방에서 나갈까요?')) return;
      await rpc('lr_leave_room', { p_room: room.id });
      localStorage.removeItem(LS_ROOM);
      showHome();
    });
  }

  const lastBtn = document.getElementById('lastResultBtn');
  if (lastBtn) lastBtn.onclick = () => { S.viewingResult = true; render(); };
}

// ----- 게임 (A안 보드) -----
function currentTurnUid(room) {
  return room.phase === 'turn' ? room.turn_order[room.turn_index] : null;
}

function cellsHtml(col, isNextCol) {
  let html = '';
  for (let i = 0; i < CELLS; i++) {
    const e = col[i];
    if (e) {
      const n = Number(e.n);
      const cls = isOver(n, i + 1) ? 'over' : n >= 100 ? 'big' : '';
      html += `<div class="cell filled ${cls}"><span class="i">${i + 1}</span><span class="n">${n}</span><span class="w">${esc(e.nick)}</span></div>`;
    } else if (i === col.length && isNextCol) {
      html += `<div class="cell next"><span class="i">${i + 1}</span><span class="w">다음</span></div>`;
    } else {
      html += `<div class="cell"><span class="i">${i + 1}</span></div>`;
    }
  }
  return html;
}

function bannerHtml() {
  const { room, me, my } = S.data;
  const isHost = room.host_id === me;
  const jailed = room.jailed.includes(me);

  switch (room.phase) {
    case 'turn': {
      const uid = currentTurnUid(room);
      if (uid === me) {
        return `<div class="banner"><span><b>내 차례예요</b><span class="sub">받은 숫자 4개로 수를 만들어 내세요</span></span>
          <button class="btn" data-open="turn">숫자 고르기</button></div>`;
      }
      const nextUid = room.turn_order[room.turn_index + 1];
      return `<div class="banner"><span><b>${esc(nickOf(uid))}</b> 님이 숫자를 고르는 중</span>
        ${nextUid ? `<span class="sub">다음: ${esc(nickOf(nextUid))}</span>` : ''}</div>`;
    }
    case 'discuss':
      return `<div class="banner calm"><span><b>${room.round}라운드 끝 · 토론 시간</b><span class="sub">누가 역적인지, 누구를 왕으로 뽑을지 이야기해 보세요</span></span>
        ${isHost ? '<button class="btn" data-act="startVote">투표 시작</button>' : ''}</div>`;
    case 'final_discuss':
      return `<div class="banner"><span><b>${overTitle(room)}</b><span class="sub">마지막 왕이 역적 2명을 정확히 감옥에 보내면 충신 역전승</span></span>
        ${isHost ? '<button class="btn" data-act="startVote">마지막 투표</button>' : ''}</div>`;
    case 'vote': {
      const total = room.vote_voters.length;
      const tie = room.vote_retry && room.last_vote?.tie
        ? `동률(${room.last_vote.tied.map(esc).join(', ')}) 재투표 · ` : '';
      const title = room.is_final ? '마지막 왕 투표' : '왕 투표';
      if (jailed) {
        return `<div class="banner soft"><span><b>${title} 중</b><span class="sub">${tie}감옥에 있어 투표할 수 없어요 · ${room.vote_done}/${total}명 완료</span></span></div>`;
      }
      if (my.vote) {
        return `<div class="banner soft"><span><b>${esc(nickOf(my.vote))}</b> 님에게 투표했어요<span class="sub">${tie}${room.vote_done}/${total}명 완료 · 마감 전까지 바꿀 수 있어요</span></span>
          <button class="btn" data-open="vote">변경</button></div>`;
      }
      return `<div class="banner"><span><b>${title}</b><span class="sub">${tie}${room.vote_done}/${total}명 완료</span></span>
        <button class="btn" data-open="vote">투표하기</button></div>`;
    }
    case 'jail': {
      const lv = room.last_vote;
      const how = lv?.method === 'random' ? ' (아무도 투표하지 않아 랜덤)'
        : lv?.method === 'tie_random' ? ' (재투표도 동률이라 랜덤)' : '';
      const title = room.is_final ? '마지막 왕' : '새로운 왕';
      if (room.king === me) {
        return `<div class="banner"><span><b>당신이 ${title}이에요</b><span class="sub">역적으로 의심되는 2명을 감옥에 보내세요${how}</span></span>
          <button class="btn" data-open="jail">감옥 지정</button></div>`;
      }
      return `<div class="banner calm"><span><b>${title}: ${esc(nickOf(room.king))}</b><span class="sub">감옥에 보낼 2명을 고르는 중${how}</span></span>
        <button class="btn" data-open="voteResult">득표</button></div>`;
    }
    default:
      return '';
  }
}

// 마지막 투표로 넘어간 이유: 1000 초과, 또는 15번째 칸이 아닌 곳의 1000
function overTitle(room) {
  const last = room.log[room.log.length - 1];
  return last && Number(last.n) === 1000 ? '1000이 나왔어요! 남은 칸은 1000을 넘을 수밖에 없어요' : '1000을 넘었어요!';
}

function renderGame() {
  const { room, me, my } = S.data;
  const isHost = room.host_id === me;
  const A = room.cols.A || [];
  const B = room.cols.B || [];
  const kingName = room.king ? nickOf(room.king) : '없음';
  const jailNames = room.jailed.length ? room.jailed.map(nickOf).join(' · ') : '없음';
  const isRebel = my.role === 'rebel';
  const showNext = room.phase === 'turn';
  const sub = room.is_final || room.phase === 'final_discuss' ? '마지막 투표' : `${room.round}라운드`;

  const inJail = room.jailed.includes(me);
  app.classList.add('game-mode');
  app.classList.toggle('in-jail', inJail);
  app.innerHTML = `
    ${inJail ? `
      <div class="jail-bars" aria-hidden="true"></div>
      <div class="jail-plate" role="status">
        <span class="k">PRISON</span>
        <b>감옥에 갇혔어요</b>
        <span>이번 라운드에는 숫자를 낼 수 없고<br/>왕 투표와 왕 후보에서도 빠져요</span>
      </div>` : ''}
    <div class="g-head">
      <div>
        <div class="g-title">충신과 역적</div>
        <div class="g-sub">${sub} · 방 ${esc(room.code)}</div>
      </div>
      <div class="g-head-right">
        ${timerPill(room)}
        <button class="pill-btn" data-help>설명</button>
        ${isHost ? '<button class="pill-btn" data-act="restart">재시작</button>' : ''}
      </div>
    </div>

    <div class="status-row">
      <div class="status-chip"><span style="color:var(--accent)">${ICON.crown}</span><span class="k">왕</span><b>${esc(kingName)}</b></div>
      <div class="status-chip jail"><span class="k">${ICON.jail}</span><span class="k">감옥</span><b>${esc(jailNames)}</b></div>
    </div>

    ${bannerHtml()}

    <div class="board">
      <div class="col">
        <div class="col-head"><span class="col-name">A열</span><span class="col-sum">최고 ${lastOf(A)} · ${A.length}/15</span></div>
        <div class="cells">${cellsHtml(A, showNext)}</div>
      </div>
      <div class="col">
        <div class="col-head"><span class="col-name">B열</span><span class="col-sum">최고 ${lastOf(B)} · ${B.length}/15</span></div>
        <div class="cells">${cellsHtml(B, showNext)}</div>
      </div>
    </div>

    <div class="legend">
      <span><i class="lb"></i>세 자리</span>
      ${showNext ? '<span><i class="ln"></i>다음 칸</span>' : ''}
      <span class="r">1000 초과 시 역적 승리</span>
    </div>

    <div class="bottom-bar">
      <button class="btn ghost" data-open="role">내 역할</button>
      <button class="btn dark" data-open="log">제출 기록</button>
      ${isRebel ? `<button class="btn primary" data-act="chat">밀담${S.chatUnseen ? `<span class="badge">${S.chatUnseen}</span>` : ''}</button>` : ''}
    </div>
  `;

  bindGameActions(app);
  tick();
}

function bindGameActions(root) {
  root.querySelectorAll('[data-open]').forEach((b) => {
    b.onclick = () => openSheet(b.dataset.open);
  });
  root.querySelectorAll('[data-act]').forEach((b) => {
    const act = b.dataset.act;
    if (act === 'startVote') {
      b.onclick = guard(async () => {
        await rpc('lr_start_vote', { p_room: S.roomId });
        await refresh();
      });
    } else if (act === 'restart') {
      b.onclick = guard(async () => {
        if (!confirm('게임을 강제 재시작할까요?\n모든 플레이어가 대기실로 돌아가고 채팅이 삭제돼요.')) return;
        await rpc('lr_force_restart', { p_room: S.roomId });
        await refresh();
      });
    } else if (act === 'chat') {
      b.onclick = openChat;
    }
  });
}

// ---------------------------------------------------------------------
// 시트 (아래에서 올라오는 창)
// ---------------------------------------------------------------------
function openSheet(type) {
  S.sheet = { type };
  if (type === 'vote') S.voteSel = S.data?.my?.vote ?? null;
  renderSheet();
}

function closeSheet() {
  S.sheet = null;
  // 역할 확인 창을 닫은 직후 내 차례/투표/감옥 창이 아직 안 열렸다면 이어서 열기
  if (S.data?.room?.status === 'playing') autoSheets();
  renderSheet();
}

// 상황에 맞춰 자동으로 여는 창: 역할 공개, 내 차례, 투표, 감옥 지정
function autoSheets() {
  const { room, me, my } = S.data;
  if (room.status !== 'playing') {
    if (S.sheet && ['turn', 'vote', 'jail', 'role', 'log', 'voteResult'].includes(S.sheet.type)) S.sheet = null;
    return;
  }
  // 더 이상 맞지 않는 창은 닫기
  if (S.sheet?.type === 'turn' && currentTurnUid(room) !== me) S.sheet = null;
  if (S.sheet?.type === 'vote' && room.phase !== 'vote') S.sheet = null;
  if (S.sheet?.type === 'jail' && !(room.phase === 'jail' && room.king === me)) S.sheet = null;
  if (S.sheet?.type === 'voteResult' && room.phase !== 'jail') S.sheet = null;

  const once = (key, type) => {
    if (S.autoOpened.has(key)) return false;
    S.autoOpened.add(key);
    S.sheet = { type };
    return true;
  };

  const roleKey = roleSeenKey(room.id, room.game_no);
  if (!localStorage.getItem(roleKey)) {
    localStorage.setItem(roleKey, '1');
    S.sheet = { type: 'role' };
    return;
  }
  if (S.sheet?.type === 'role' || S.sheet?.type === 'help') return;

  if (room.phase === 'turn' && currentTurnUid(room) === me) {
    once(`turn:${room.game_no}:${room.log.length}`, 'turn');
  } else if (room.phase === 'vote' && room.vote_voters.includes(me) && !my.vote) {
    if (once(`vote:${room.game_no}:${room.vote_no}`, 'vote')) S.voteSel = null;
  } else if (room.phase === 'jail' && room.king === me) {
    if (once(`jail:${room.game_no}:${room.round}:${room.is_final}`, 'jail')) S.jailSel = [];
  }
}

function sheetFrame(inner, { dark = false, full = false, compact = false, closable = true } = {}) {
  return `
    <div class="sheet-backdrop" ${closable ? 'data-close' : ''}></div>
    <section class="sheet ${dark ? 'dark' : ''} ${full ? 'full' : ''} ${compact ? 'compact' : ''}" role="dialog">
      ${inner}
    </section>`;
}

const closeBtn = '<button class="icon-btn" data-close aria-label="닫기">' + ICON.close + '</button>';

function renderSheet() {
  if (!S.sheet || !S.data && S.sheet.type !== 'help') {
    sheetRoot.innerHTML = '';
    delete sheetRoot.dataset.type;
    return;
  }
  const t = S.sheet.type;
  // 같은 창을 다시 그릴 때(숫자 누름, 상태 갱신)는 올라오는 효과와 스크롤 이동 없이 그대로 유지
  const same = sheetRoot.dataset.type === t && !!sheetRoot.querySelector('.sheet');
  const prevScroll = same ? sheetRoot.querySelector('.sheet').scrollTop : 0;
  const openDetails = same ? [...sheetRoot.querySelectorAll('details')].map((d) => d.open) : [];
  if (t === 'help') sheetRoot.innerHTML = sheetFrame(helpHtml());
  else if (t === 'role') sheetRoot.innerHTML = sheetFrame(roleHtml(), { compact: true });
  else if (t === 'log') sheetRoot.innerHTML = sheetFrame(logHtml());
  else if (t === 'turn') sheetRoot.innerHTML = sheetFrame(turnHtml(), { dark: true, full: true });
  else if (t === 'vote') sheetRoot.innerHTML = sheetFrame(voteHtml());
  else if (t === 'jail') sheetRoot.innerHTML = sheetFrame(jailHtml(), { dark: true, full: true });
  else if (t === 'voteResult') sheetRoot.innerHTML = sheetFrame(voteResultHtml());
  else sheetRoot.innerHTML = '';

  sheetRoot.dataset.type = t;
  const sheetEl = sheetRoot.querySelector('.sheet');
  if (sheetEl && same) {
    sheetEl.classList.add('still');
    sheetEl.scrollTop = prevScroll;
    sheetRoot.querySelectorAll('details').forEach((d, i) => { if (openDetails[i]) d.open = true; });
  }

  sheetRoot.querySelectorAll('[data-close]').forEach((el) => { el.onclick = closeSheet; });
  if (t === 'turn') bindTurn();
  if (t === 'vote') bindVote();
  if (t === 'jail') bindJail();
  tick();
}

// ----- 게임 설명 -----
function helpHtml() {
  return `
    <div class="sheet-head"><h2>충신과 역적</h2>${closeBtn}</div>
    <div class="help">
      <p class="lead">충신은 숫자가 <b>1000을 넘지 않게</b>, 역적은 <b>1000을 넘기게</b> 만드는 게임이에요.</p>
      <h3>준비</h3>
      <ul>
        <li>7~12명이 참가하고, 인원의 1/3(내림)이 역적이 돼요. 9명이면 역적 3명.</li>
        <li>충신은 누가 역적인지 모르고, 역적끼리는 서로를 알아요.</li>
        <li>역적은 화면의 <b>밀담</b>으로 몰래 이야기할 수 있어요. 게임이 끝나면 모두에게 공개돼요.</li>
        <li>보드는 A열, B열 각 15칸, 총 30칸이에요.</li>
      </ul>
      <h3>숫자 내기</h3>
      <ol>
        <li>순서대로 한 명씩, 자기 폰으로만 보이는 <b>랜덤 숫자 4개</b>를 받아요.</li>
        <li>숫자 30조합은 게임 시작 때 미리 정해져요. 잘 계획하면 30칸을 끝까지 채울 수 있는 조합만 나와요. 몇 번째 칸이냐에 따라 숫자가 정해지고, 누가 받는지는 차례에 따라 달라져요.</li>
        <li>그중 원하는 숫자를 골라 한 자리~네 자리 수를 만들어, A열이나 B열의 다음 칸에 넣어요. 각 숫자는 한 번씩만 쓸 수 있어요.</li>
        <li>같은 열의 직전 칸보다 <b>커야</b> 하고, 자릿수는 직전보다 <b>한 단계까지만</b> 올릴 수 있어요. 첫 칸은 한 자리만 가능해요.</li>
        <li>앞자리에 0은 쓸 수 없어요.</li>
        <li>낸 숫자는 모두에게 공개되지만, 받은 숫자 4개는 본인만 알아요.</li>
        <li>시간이 지나면 낼 수 있는 가장 작은 수가, 결과가 더 작아지는 열에 자동으로 들어가요.</li>
      </ol>
      <h3>왕과 감옥</h3>
      <ol>
        <li>모두 한 번씩 내면 라운드가 끝나고 토론 시간이 돼요. 방장이 <b>투표 시작</b>을 누르면 왕 투표를 해요.</li>
        <li>자기 자신에게는 투표할 수 없고, 누가 누구를 찍었는지는 공개되지 않아요. 동률이면 동률 후보끼리 한 번 더 투표하고, 그래도 동률이면 랜덤이에요.</li>
        <li>왕은 역적으로 의심되는 <b>2명을 감옥</b>에 보내요. 감옥에 간 사람은 다음 라운드에 숫자를 낼 수 없고, 왕 투표권과 피선거권도 없어요.</li>
      </ol>
      <h3>승리 조건</h3>
      <ul>
        <li>30칸을 모두 채울 때까지 1000을 넘지 않으면 <b>충신 승리</b>.</li>
        <li>한 열이라도 <b>1000을 넘으면</b> 역적이 이긴 상태로 마지막 투표를 해요.</li>
        <li><b>1000</b>은 그 열의 <b>15번째 칸</b>일 때만 괜찮아요. 그 앞 칸에 1000이 들어가면 남은 칸은 반드시 1000을 넘으니 바로 1000을 넘은 것으로 처리해요.</li>
        <li>감옥 밖 사람들이 비밀투표로 <b>마지막 왕</b>을 뽑고, 마지막 왕이 감옥에 보낸 2명이 <b>모두 역적</b>이면 충신 역전승, 아니면 역적 승리예요.</li>
      </ul>
    </div>`;
}

// ----- 내 역할 -----
function roleHtml() {
  const { my, room } = S.data;
  if (!my.role) return `<div class="sheet-head"><h2>내 역할</h2>${closeBtn}</div><div class="empty">게임이 시작되면 역할이 정해져요</div>`;
  const rebel = my.role === 'rebel';
  const mates = (my.teammates || []).filter((u) => u !== S.data.me).map((u) => `<b>${esc(nickOf(u))}</b>`).join(', ');
  return `
    <div class="sheet-head"><h2 style="font-size:16px">내 역할 · GAME ${room.game_no}</h2>${closeBtn}</div>
    <div class="role-card">
      <span class="r ${rebel ? 'rebel' : ''}">${rebel ? '역적' : '충신'}</span>
      <p>${rebel
        ? '숫자가 1000을 넘게 만드세요. 들키지 않는 게 중요해요.'
        : '숫자가 1000을 넘지 않게 지키고, 역적을 찾아내세요.'}</p>
      ${rebel ? `<div class="mates">함께하는 역적: ${mates || '없음'}</div>` : ''}
    </div>
    <button class="btn dark block" data-close style="height:42px;font-size:15px">확인</button>`;
}

// ----- 제출 기록 -----
function logHtml() {
  const { room } = S.data;
  const rows = [...room.log].reverse().map((l) => `
    <div class="log-row">
      <span class="r">R${l.round}</span>
      <span>${esc(l.nick)}${l.auto ? ' <span class="tag">자동</span>' : ''}</span>
      <span class="c">${l.col}열</span>
      <span class="v">${l.n}</span>
    </div>`).join('');
  return `
    <div class="sheet-head"><div><h2>제출 기록</h2><p class="sub">최신순 · 자동은 시간 초과로 들어간 수</p></div>${closeBtn}</div>
    <div class="log">${rows || '<div class="empty">아직 낸 숫자가 없어요</div>'}</div>`;
}

// ----- 내 차례 -----
function composeState() {
  const { room } = S.data;
  const key = `${room.game_no}:${room.log.length}`;
  if (S.compose.key !== key) S.compose = { key, picks: [], col: null };
  return S.compose;
}

function turnHtml() {
  const { room, my } = S.data;
  const digits = my.digits || [];
  const c = composeState();
  const numStr = c.picks.map((i) => digits[i]).join('');
  const A = room.cols.A || [];
  const B = room.cols.B || [];
  const ra = colReason(numStr, A);
  const rb = colReason(numStr, B);
  if (c.col === 'A' && ra) c.col = null;
  if (c.col === 'B' && rb) c.col = null;

  const minA = minValid(digits, A);
  const minB = minValid(digits, B);
  let autoCol = null; let autoNum = null;
  if (minA != null && (minB == null || minA <= minB)) { autoCol = 'A'; autoNum = minA; }
  else if (minB != null) { autoCol = 'B'; autoNum = minB; }

  const digitBtns = digits.map((d, i) => {
    const used = c.picks.includes(i);
    const order = used ? c.picks.indexOf(i) + 1 : '';
    return `<button class="digit ${used ? 'used' : ''}" data-digit="${i}"
      aria-label="${d}${used ? ' 사용됨' : ''}">${d}${order ? `<span class="ord">${order}</span>` : ''}</button>`;
  }).join('');

  const colBtn = (name, col, reason) => {
    const last = lastOf(col);
    const ok = !reason;
    const over = ok && isOver(Number(numStr), col.length + 1);
    return `<button class="colbtn ${c.col === name ? 'sel' : ''}" data-col="${name}" ${ok ? '' : 'disabled'}>
      <span class="cn">${name}열</span>
      <span class="cv">직전 ${col.length ? last : '없음'} → ${numStr ? `<b>${numStr}</b>` : '?'}</span>
      <span class="cs ${over ? 'no' : ok ? 'ok' : numStr || col.length >= CELLS ? 'no' : ''}">${over ? '가능 · 내면 역적 승리 조건'
        : ok ? '제출 가능'
        : numStr || col.length >= CELLS ? `불가 · ${reason}` : '숫자를 먼저 골라 주세요'}</span>
    </button>`;
  };

  const minLine = [
    minA != null ? `A열 <b>${minA}</b>` : null,
    minB != null ? `B열 <b>${minB}</b>` : null,
  ].filter(Boolean).join(', ');

  const timed = !!room.deadline;
  return `
    <div class="sheet-head">
      <div><h2>내 차례</h2><p class="sub">이 화면은 다른 사람에게 보이지 않게 하세요</p></div>
      <div class="g-head-right">${timerPill(room)}<button class="icon-btn" data-close aria-label="닫기">${ICON.close}</button></div>
    </div>
    ${timed ? '<div class="timebar" data-timebar><i></i></div>' : ''}
    <span class="label">받은 숫자 4개 · 누른 순서대로 수가 만들어져요</span>
    <div class="digits">${digitBtns}</div>
    <div class="made">
      <span class="v ${numStr ? '' : 'ph'}">${numStr || '숫자를 눌러 주세요'}</span>
      <button class="btn" data-clear ${numStr ? '' : 'disabled'}>지우기</button>
    </div>
    <span class="label">넣을 열 선택</span>
    <div class="colpick">${colBtn('A', A, ra)}${colBtn('B', B, rb)}</div>
    <div class="hint">
      가장 작게 낼 수 있는 수: ${minLine || '없음'}
      ${timed && autoCol ? `<br/>시간이 지나면 ${autoCol}열에 ${autoNum}이(가) 자동 제출돼요` : ''}
    </div>
    <button class="btn primary block" data-submit ${c.col && numStr ? '' : 'disabled'}>
      ${c.col && numStr ? `${c.col}열에 ${numStr} 제출` : '숫자와 열을 골라 주세요'}
    </button>
    <span class="label" style="text-align:center">낸 숫자는 모두에게 공개되고, 받은 숫자 4개는 나만 봐요</span>`;
}

function bindTurn() {
  const c = composeState();
  sheetRoot.querySelectorAll('[data-digit]').forEach((b) => {
    b.onclick = () => {
      const i = Number(b.dataset.digit);
      const digits = S.data.my.digits || [];
      if (!c.picks.includes(i) && c.picks.length === 0 && digits[i] === 0) {
        toast('0으로 시작할 수 없어요', true);
        return;
      }
      if (c.picks.includes(i)) {
        // 마지막에 고른 숫자를 다시 누르면 취소
        if (c.picks[c.picks.length - 1] === i) c.picks.pop();
      } else {
        c.picks.push(i);
      }
      renderSheet();
    };
  });
  sheetRoot.querySelector('[data-clear]').onclick = () => { c.picks = []; c.col = null; renderSheet(); };
  sheetRoot.querySelectorAll('[data-col]').forEach((b) => {
    b.onclick = () => { c.col = b.dataset.col; renderSheet(); };
  });
  sheetRoot.querySelector('[data-submit]').onclick = guard(async () => {
    const digits = S.data.my.digits || [];
    const num = Number(c.picks.map((i) => digits[i]).join(''));
    if (!c.col || !num) return;
    await rpc('lr_submit', { p_room: S.roomId, p_col: c.col, p_num: num });
    S.sheet = null;
    renderSheet();
    await refresh();
  });
}

// ----- 왕 투표 -----
function voteHtml() {
  const { room, me } = S.data;
  const cands = room.vote_candidates.filter((u) => u !== me);
  const title = room.is_final ? '마지막 왕 투표' : '왕 투표';
  const sub = room.is_final
    ? '마지막 왕이 감옥에 보낸 2명이 모두 역적이면 충신 역전승'
    : `${room.round + 1}라운드의 왕을 뽑아요`;
  const tie = room.vote_retry && room.last_vote?.tie
    ? `<div class="infobox">동률이라 <b>${room.last_vote.tied.map(esc).join(', ')}</b> 중에서 다시 투표해요. 이번에도 동률이면 랜덤으로 정해요.</div>` : '';
  const list = cands.map((u) => `
    <button class="choice ${S.voteSel === u ? 'sel' : ''}" data-pick="${u}">
      <span class="dot"></span><span>${esc(nickOf(u))}</span>
      ${u === room.king ? '<span class="t">현재 왕</span>' : ''}
    </button>`).join('');
  const jailedNames = room.jailed.map(nickOf);
  const total = room.vote_voters.length;
  return `
    <div class="sheet-head"><div><h2>${title}</h2><p class="sub">${sub}</p></div>
      <div class="g-head-right">${timerPill(room)}${closeBtn}</div></div>
    <div class="infobox">비밀투표예요. 결과는 후보별 득표 수만 공개되고, 누가 누구를 찍었는지는 공개되지 않아요.</div>
    ${tie}
    <div class="row-between"><b>후보 ${cands.length}명</b><span>본인${jailedNames.length ? ' · 감옥 인원' : ''} 제외</span></div>
    <div class="choice-list">${list}</div>
    ${jailedNames.length ? `<p class="note">${jailedNames.map(esc).join(', ')} 님은 감옥에 있어 투표할 수 없어요</p>` : ''}
    <div class="row-between"><span>투표 완료</span><b>${room.vote_done} / ${total}명</b></div>
    <div class="progress"><i style="width:${Math.round((room.vote_done / Math.max(1, total)) * 100)}%"></i></div>
    <button class="btn primary block" data-vote ${S.voteSel ? '' : 'disabled'}>
      ${S.voteSel ? `${esc(nickOf(S.voteSel))}에게 투표` : '후보를 골라 주세요'}
    </button>`;
}

function bindVote() {
  sheetRoot.querySelectorAll('[data-pick]').forEach((b) => {
    b.onclick = () => { S.voteSel = b.dataset.pick; renderSheet(); };
  });
  sheetRoot.querySelector('[data-vote]').onclick = guard(async () => {
    if (!S.voteSel) return;
    await rpc('lr_vote', { p_room: S.roomId, p_target: S.voteSel });
    toast('투표했어요');
    S.sheet = null;
    renderSheet();
    await refresh();
  });
}

// ----- 투표 결과 -----
function voteResultBars(lv) {
  if (!lv?.counts?.length) return '<div class="empty">투표한 사람이 없어요</div>';
  const max = Math.max(...lv.counts.map((c) => c.votes), 1);
  return `<div class="vote-bars">${lv.counts.map((c) => `
    <div class="vote-bar ${c.user_id === lv.winner ? 'win' : ''}">
      <span class="nm">${esc(c.nickname)}</span>
      <span class="tr"><i style="width:${Math.round((c.votes / max) * 100)}%"></i></span>
      <span class="ct">${c.votes}표</span>
    </div>`).join('')}</div>`;
}

function voteResultHtml() {
  const { room } = S.data;
  const lv = room.last_vote;
  return `
    <div class="sheet-head"><div><h2>투표 결과</h2><p class="sub">${room.is_final ? '마지막 왕' : '새로운 왕'}: ${esc(nickOf(room.king))}</p></div>${closeBtn}</div>
    ${voteResultBars(lv)}
    <p class="note">누가 누구를 찍었는지는 공개되지 않아요.</p>`;
}

// ----- 감옥 지정 (왕) -----
function jailHtml() {
  const { room, players, me } = S.data;
  const others = players.filter((p) => p.user_id !== me);
  const sel = S.jailSel;
  const lv = room.last_vote;
  const list = others.map((p) => `
    <button class="choice ${sel.includes(p.user_id) ? 'sel' : ''}" data-jail="${p.user_id}">
      <span class="dot box"></span><span>${esc(p.nickname)}</span>
      ${room.jailed.includes(p.user_id) ? '<span class="t">지난 감옥</span>' : ''}
    </button>`).join('');
  const names = sel.map(nickOf).map(esc).join(' · ');
  return `
    <div class="sheet-head">
      <div><h2>당신은 ${room.is_final ? '마지막 왕' : '왕'}이에요</h2>
        <p class="sub">${room.is_final ? '2명이 모두 역적이면 충신 역전승이에요' : '역적으로 의심되는 2명을 감옥에 보내세요'}</p></div>
      <div class="g-head-right">${timerPill(room)}<button class="icon-btn" data-close aria-label="닫기">${ICON.close}</button></div>
    </div>
    ${room.deadline ? '<div class="timebar" data-timebar><i></i></div>' : ''}
    <div class="infobox">${room.is_final
      ? '마지막 감옥이에요. 고른 2명이 모두 역적이어야 충신이 이겨요.'
      : '감옥에 간 2명은 다음 라운드에 숫자를 낼 수 없고, 다음 왕 투표의 투표권과 피선거권도 없어요. 지난 감옥 인원을 다시 보낼 수도 있어요.'}
      ${room.deadline ? '<br/>시간이 지나면 랜덤 2명이 지정돼요.' : ''}</div>
    <div class="row-between"><b style="color:inherit">플레이어 ${others.length}명</b><span style="color:#e0a493;font-weight:700">${sel.length} / 2 선택</span></div>
    <div class="choice-grid">${list}</div>
    ${lv?.counts ? `<details class="infobox"><summary>득표 수 보기</summary>${voteResultBars(lv)}</details>` : ''}
    <button class="btn primary block" data-jailgo ${sel.length === 2 ? '' : 'disabled'}>
      ${sel.length === 2 ? `${names} 감옥 보내기` : '2명을 골라 주세요'}
    </button>`;
}

function bindJail() {
  sheetRoot.querySelectorAll('[data-jail]').forEach((b) => {
    b.onclick = () => {
      const u = b.dataset.jail;
      if (S.jailSel.includes(u)) S.jailSel = S.jailSel.filter((x) => x !== u);
      else if (S.jailSel.length < 2) S.jailSel = [...S.jailSel, u];
      else S.jailSel = [S.jailSel[1], u];
      renderSheet();
    };
  });
  sheetRoot.querySelector('[data-jailgo]').onclick = guard(async () => {
    if (S.jailSel.length !== 2) return;
    const names = S.jailSel.map(nickOf).join(', ');
    if (!confirm(`${names} 님을 감옥에 보낼까요?`)) return;
    await rpc('lr_jail', { p_room: S.roomId, p_targets: S.jailSel });
    S.jailSel = [];
    S.sheet = null;
    renderSheet();
    await refresh();
  });
}

// ---------------------------------------------------------------------
// 역적 밀담 (게임 중)
// ---------------------------------------------------------------------
function syncChat() {
  const { room, my, me } = S.data;
  const want = room.status === 'playing' && my.role === 'rebel';
  const key = want ? `${room.id}:${room.game_no}` : null;
  if (key === S.chatKey) return;
  closeChat(true);
  if (!want) return;
  S.chatKey = key;
  S.chatUnseen = 0;
  S.chat = mountTeamChat({
    sb, game: 'loyal', roomId: room.id, team: 'rebel', me,
    el: document.getElementById('chatBody'),
    emptyText: '역적끼리만 보이는 대화예요.<br/>작전을 세워 보세요.',
    onNew: (n) => {
      S.chatUnseen = chatRoot.hidden ? n : 0;
      const btn = app.querySelector('[data-act="chat"]');
      if (btn) btn.innerHTML = `밀담${S.chatUnseen ? `<span class="badge">${S.chatUnseen}</span>` : ''}`;
    },
    onError: (m) => toast(m, true),
  });
}

function openChat() {
  if (!S.chat) return;
  chatRoot.hidden = false;
  S.chat.clearUnseen();
  S.chatUnseen = 0;
  const btn = app.querySelector('[data-act="chat"]');
  if (btn) btn.innerHTML = '밀담';
}

function closeChat(destroy = false) {
  chatRoot.hidden = true;
  if (destroy && S.chat) {
    S.chat.destroy();
    S.chat = null;
    S.chatKey = null;
    S.chatUnseen = 0;
  }
}
chatRoot.querySelectorAll('[data-close-chat]').forEach((el) => { el.onclick = () => closeChat(false); });

// ---------------------------------------------------------------------
// 결과
// ---------------------------------------------------------------------
function destroyResultChat() {
  if (S.resultChat) { S.resultChat.destroy(); S.resultChat = null; }
}

function renderResult(fromLobby) {
  const { room, me } = S.data;
  const r = room.result;
  const isHost = room.host_id === me;
  const loyalWin = r.winner === 'loyal';
  const myRole = (r.roles.find((p) => p.user_id === me) || {}).role;
  const iWon = myRole === r.winner;
  const nick = (u) => (r.roles.find((p) => p.user_id === u) || {}).nickname || '?';

  const roles = r.roles.map((p) => `
    <li class="${p.role}">
      <span class="name">${esc(p.nickname)}${p.user_id === me ? ' (나)' : ''}</span>
      ${r.went_over && p.user_id === r.final_king ? '<span class="tag host">마지막 왕</span>' : ''}
      ${r.went_over && r.final_jailed.includes(p.user_id) ? '<span class="tag">마지막 감옥</span>' : ''}
      <span class="tag ${p.role === 'rebel' ? 'rebel' : ''}">${p.role === 'rebel' ? '역적' : '충신'}</span>
    </li>`).join('');

  const mini = (name, col) => `<div class="mini-col"><span class="h">${name}열</span>${col.map((e, i) => {
    const n = Number(e.n);
    return `<span class="${isOver(n, i + 1) ? 'over' : n >= 100 ? 'big' : ''}">${n}</span>`;
  }).join('') || '<span>없음</span>'}</div>`;

  const finalLine = r.went_over
    ? `<div class="infobox">마지막 왕 <b>${esc(nick(r.final_king))}</b> 님이 <b>${r.final_jailed.map((u) => esc(nick(u))).join(', ')}</b> 님을 감옥에 보냈어요.</div>`
    : '';

  app.innerHTML = `
    <div class="result-hero ${loyalWin ? 'loyal' : 'rebel'}">
      <span class="k">GAME ${r.game_no}</span>
      <h1>${loyalWin ? '충신 승리' : '역적 승리'}</h1>
      ${r.comeback ? '<span class="comeback">역전승</span>' : ''}
      <p>${esc(r.reason)}</p>
      ${myRole ? `<p><b>${iWon ? '내가 속한 팀이 이겼어요' : '내가 속한 팀이 졌어요'}</b> · 나는 ${myRole === 'rebel' ? '역적' : '충신'}</p>` : ''}
    </div>
    ${finalLine}
    <section class="panel"><h2>역할 공개</h2><ul class="roles">${roles}</ul></section>
    <section class="panel"><h2>최종 보드</h2><div class="mini-board">${mini('A', r.cols.A || [])}${mini('B', r.cols.B || [])}</div></section>
    ${fromLobby ? '' : `<section class="panel"><h2>역적 밀담 공개</h2><div id="resultChat" class="result-chat"></div></section>`}
    <div class="actions">
      ${fromLobby
        ? '<button id="backBtn" class="btn dark block">대기실로</button>'
        : isHost
          ? '<button id="lobbyBtn" class="btn primary block">대기실로 돌아가기</button><p class="note" style="text-align:center">대기실로 돌아가면 밀담 기록이 삭제돼요</p>'
          : '<div class="panel" style="text-align:center;color:var(--muted)">방장이 대기실로 돌아가면 다음 게임을 준비해요</div>'}
    </div>
  `;

  destroyResultChat();
  if (!fromLobby) {
    S.resultChat = mountTeamChat({
      sb, game: 'loyal', roomId: room.id, team: 'rebel', me,
      el: document.getElementById('resultChat'),
      readOnly: true,
      emptyText: '역적들이 나눈 대화가 없어요',
    });
    const lobbyBtn = document.getElementById('lobbyBtn');
    if (lobbyBtn) {
      lobbyBtn.onclick = guard(async () => {
        await rpc('lr_back_to_lobby', { p_room: room.id });
        await refresh();
      });
    }
  } else {
    document.getElementById('backBtn').onclick = () => { S.viewingResult = false; render(); };
  }
}

// ---------------------------------------------------------------------
// 게임 설명 버튼 (어느 화면에서든)
// ---------------------------------------------------------------------
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-help]')) {
    S.sheet = { type: 'help' };
    renderSheet();
  }
});

boot();
