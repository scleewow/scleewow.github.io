// =====================================================================
// 공용 팀 채팅 모듈 (shared/team-chat.sql 과 함께 사용)
// ---------------------------------------------------------------------
// 사용 예:
//   import { mountTeamChat } from '../shared/team-chat.js';
//   const chat = mountTeamChat({
//     sb, game: 'loyal', roomId, team: 'rebel', me: myUserId,
//     el: document.getElementById('chatBox'),
//     readOnly: false,                     // true 면 입력창 없이 기록만 표시
//     onNew: (count) => {},                // 내가 보낸 것 외 새 메시지 수 (배지용)
//     onError: (msg) => alert(msg),
//   });
//   chat.destroy();   // 화면을 떠날 때
//
// 읽기/쓰기 권한은 서버(RLS)가 판단합니다. 권한이 없으면 빈 목록이 보이고 전송이 거부돼요.
// 색은 CSS 변수로 바꿀 수 있습니다: --tc-bg, --tc-fg, --tc-muted, --tc-line, --tc-mine, --tc-mine-fg, --tc-accent
// =====================================================================

const MAX_LEN = 100;
const POLL_MS = 8000;

const STYLE = `
.tc{display:flex;flex-direction:column;gap:8px;min-height:0;height:100%;color:var(--tc-fg,#1d1c1a);font:inherit}
.tc-list{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:6px;padding:4px 2px}
.tc-empty{margin:auto;color:var(--tc-muted,#6b675f);font-size:13px;text-align:center;line-height:1.6}
.tc-msg{max-width:82%;display:flex;flex-direction:column;gap:2px;align-self:flex-start}
.tc-msg.mine{align-self:flex-end;align-items:flex-end}
.tc-who{font-size:11px;color:var(--tc-muted,#6b675f);padding:0 4px}
.tc-body{background:var(--tc-bg,#fff);border:1px solid var(--tc-line,#ddd7cb);border-radius:12px;padding:7px 11px;font-size:14px;line-height:1.45;word-break:break-word;white-space:pre-wrap}
.tc-msg.mine .tc-body{background:var(--tc-mine,#1d1c1a);color:var(--tc-mine-fg,#fff);border-color:transparent}
.tc-form{display:flex;gap:6px;align-items:center}
.tc-input{flex:1;min-width:0;height:44px;box-sizing:border-box;border:1px solid var(--tc-line,#ddd7cb);border-radius:12px;padding:0 12px;font:inherit;font-size:15px;background:var(--tc-bg,#fff);color:var(--tc-fg,#1d1c1a)}
.tc-send{height:44px;padding:0 16px;border:none;border-radius:12px;background:var(--tc-accent,#a9412c);color:#fff;font:inherit;font-weight:700;font-size:15px}
.tc-send:disabled{opacity:.45}
.tc-count{font-size:11px;color:var(--tc-muted,#6b675f);text-align:right;padding:0 4px}
.tc-count.full{color:var(--tc-accent,#a9412c);font-weight:700}
`;

function injectStyle() {
  if (document.getElementById('team-chat-style')) return;
  const s = document.createElement('style');
  s.id = 'team-chat-style';
  s.textContent = STYLE;
  document.head.appendChild(s);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function timeLabel(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function mountTeamChat({ sb, game, roomId, team, me, el, readOnly = false, onNew, onError, emptyText }) {
  injectStyle();
  const msgs = new Map();   // id -> message
  let destroyed = false;
  let channel = null;
  let poll = null;
  let unseen = 0;
  let sending = false;

  el.innerHTML = `
    <div class="tc">
      <div class="tc-list" role="log" aria-live="polite"></div>
      ${readOnly ? '' : `
        <div class="tc-count"><span class="tc-n">0</span>/${MAX_LEN}</div>
        <form class="tc-form">
          <input class="tc-input" maxlength="${MAX_LEN}" placeholder="메시지 입력" autocomplete="off" aria-label="메시지" />
          <button class="tc-send" type="submit">보내기</button>
        </form>`}
    </div>`;

  const $list = el.querySelector('.tc-list');
  const $form = el.querySelector('.tc-form');
  const $input = el.querySelector('.tc-input');
  const $send = el.querySelector('.tc-send');
  const $n = el.querySelector('.tc-n');
  const $count = el.querySelector('.tc-count');

  function render() {
    const nearBottom = $list.scrollHeight - $list.scrollTop - $list.clientHeight < 60;
    const list = [...msgs.values()].sort((a, b) => a.id - b.id);
    if (list.length === 0) {
      $list.innerHTML = `<div class="tc-empty">${emptyText || '아직 메시지가 없어요'}</div>`;
      return;
    }
    $list.innerHTML = list.map((m) => {
      const mine = m.user_id === me;
      return `<div class="tc-msg ${mine ? 'mine' : ''}">
        <span class="tc-who">${mine ? '나' : esc(m.nickname)} · ${timeLabel(m.created_at)}</span>
        <span class="tc-body">${esc(m.body)}</span>
      </div>`;
    }).join('');
    if (nearBottom || readOnly) $list.scrollTop = $list.scrollHeight;
  }

  function add(rows, fromRealtime) {
    let added = 0;
    for (const m of rows) {
      if (m.game !== undefined && (m.game !== game || m.room_id !== roomId || m.team !== team)) continue;
      if (!msgs.has(m.id)) {
        msgs.set(m.id, m);
        if (m.user_id !== me) added++;
      }
    }
    if (added && fromRealtime !== null) {
      unseen += added;
      onNew?.(unseen);
    }
    render();
  }

  async function load(first) {
    const { data, error } = await sb.from('team_chat')
      .select('id,game,room_id,team,user_id,nickname,body,created_at')
      .eq('game', game).eq('room_id', roomId).eq('team', team)
      .order('id', { ascending: true }).limit(500);
    if (destroyed) return;
    if (error) { console.warn(error); return; }
    add(data || [], first ? null : false);
  }

  if (!readOnly) {
    const updateCount = () => {
      const len = $input.value.length;
      $n.textContent = len;
      $count.classList.toggle('full', len >= MAX_LEN);
      $send.disabled = sending || $input.value.trim().length === 0;
    };
    $input.addEventListener('input', updateCount);
    updateCount();

    $form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = $input.value.trim().slice(0, MAX_LEN);
      if (!body || sending) return;
      sending = true; updateCount();
      const { data, error } = await sb.from('team_chat')
        .insert({ game, room_id: roomId, team, body })
        .select('id,game,room_id,team,user_id,nickname,body,created_at')
        .single();
      sending = false;
      if (error) {
        const msg = /한도/.test(error.message) ? '채팅 한도(500개)에 도달했어요'
          : /row-level security/i.test(error.message) ? '지금은 메시지를 보낼 수 없어요'
          : error.message;
        onError?.(msg);
      } else {
        $input.value = '';
        add([data], null);
        $list.scrollTop = $list.scrollHeight;
      }
      updateCount();
      $input.focus();
    });
  }

  channel = sb.channel(`tc:${game}:${roomId}:${team}:${Math.random().toString(36).slice(2, 8)}`)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'team_chat', filter: `room_id=eq.${roomId}` },
      (p) => add([p.new], true))
    .subscribe();
  poll = setInterval(() => { if (document.visibilityState === 'visible') load(false); }, POLL_MS);
  load(true);

  return {
    refresh: () => load(false),
    clearUnseen: () => { unseen = 0; onNew?.(0); $list.scrollTop = $list.scrollHeight; },
    focus: () => $input?.focus(),
    destroy: () => {
      destroyed = true;
      clearInterval(poll);
      if (channel) sb.removeChannel(channel);
      el.innerHTML = '';
    },
  };
}
