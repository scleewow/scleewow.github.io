// --- 게임 상태 및 세션 변수 ---
let myName = "";
let isHost = false;
let mySessionId = localStorage.getItem("avalon_session_id") || "user_" + Math.random().toString(36).substring(2, 9);
localStorage.setItem("avalon_session_id", mySessionId);

let gameState = {
  roomId: null,
  phase: 'LOBBY',
  players: {},
  rolesConfig: {},
  questResults: [], 
  currentQuest: 0,
  rejectCount: 0,
  leaderSessionId: null,
  selectedTeam: [],
  teamVotes: {},
  missionVotes: {},
  winner: null,
  logs: []
};

const QUEST_CONFIG = {
  5: [2, 3, 2, 3, 3],
  6: [2, 3, 4, 3, 4],
  7: [2, 3, 3, 4, 4],
  8: [3, 4, 4, 5, 5],
  9: [3, 4, 4, 5, 5],
  10: [3, 4, 4, 5, 5]
};

// 캐릭터 특성 정보 데이터
const CHARACTER_INFO = [
  { name: "머린 (선)", desc: "모든 악의 무리(모드레드 제외)를 파악할 수 있습니다. 단, 정체가 발각되어 암살당하면 패배합니다." },
  { name: "퍼시벌 (선)", desc: "머린과 모거나 2명을 머린 후보로 봅니다. 진짜 머린을 찾아 보호하고 조력해야 합니다." },
  { name: "시종 (선)", desc: "특수 능력은 없지만 표를 행사하고 논리적인 추리로 원정을 성공시켜야 합니다." },
  { name: "암살자 (악)", desc: "선 세력이 3승을 거두더라도 마지막에 진짜 머린을 지목하여 암살하면 역전 승리합니다." },
  { name: "모거나 (악)", desc: "퍼시벌에게 자신이 머린인 것처럼 혼란을 줍니다." },
  { name: "모드레드 (악)", desc: "머린에게 자신의 정체를 숨길 수 있는 강력한 악의 세력입니다." },
  { name: "오베론 (악)", desc: "다른 악의 세력과 서로의 정체를 알 수 없는 고독한 악입니다." },
  { name: "악의 무리 (악)", desc: "특별한 기능은 없지만 동료 악의 무리와 협력하여 원정을 방해해야 합니다." }
];

// ===== 요소 참조 =====
let screens, inputs, displays, lists;

function initializeElements() {
  screens = {
    lobby: document.getElementById('screen-lobby'),
    room: document.getElementById('screen-room'),
    game: document.getElementById('screen-game')
  };
  inputs = {
    name: document.getElementById('player-name'),
    createPassword: document.getElementById('create-password'),
    roomId: document.getElementById('room-id')
  };
  displays = {
    roomId: document.getElementById('display-room-id'),
    playerCount: document.getElementById('player-count'),
    rejectCount: document.getElementById('reject-count'),
    currentLeader: document.getElementById('current-leader'),
    secretContent: document.getElementById('secret-content'),
    secretHint: document.getElementById('secret-hint')
  };
  lists = {
    waiting: document.getElementById('waiting-player-list'),
    game: document.getElementById('game-player-list'),
    log: document.getElementById('log-box')
  };
}

// --- 무작위 셔플 함수 (Crypto API) ---
function secureShuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const randomBuffer = new Uint32Array(1);
    window.crypto.getRandomValues(randomBuffer);
    const j = randomBuffer[0] % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// --- 초기화 및 세션 복구 ---
window.onload = async function() {
  try {
    initializeElements();
    if (typeof renderHelpModalList === 'function') {
      renderHelpModalList();
    }
    
    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room');

    if (roomParam) {
      inputs.roomId.value = roomParam.toUpperCase();
      document.getElementById('join-ui')?.classList.remove('hidden');
    }

    const savedSession = sessionStorage.getItem('avalon_active_session');
    if (savedSession) {
      try {
        const session = JSON.parse(savedSession);
        myName = session.name;
        inputs.name.value = myName;
        isHost = session.isHost;
        await startRoomListing(session.roomId.toUpperCase());
        return;
      } catch(e) {
        console.error('세션 복구 오류:', e);
        sessionStorage.removeItem('avalon_active_session');
      }
    }
  } catch(e) {
    console.error('onload 오류:', e);
    alert('초기화 중 오류 발생: ' + e.message);
  }
};

// --- DB 구독 및 동기화 ---
async function startRoomListing(roomId) {
  try {
    if (!roomId) return;
    const formattedRoomId = roomId.toUpperCase();
    gameState.roomId = formattedRoomId;
    const roomRef = database.ref('rooms/' + formattedRoomId);

    const snapshot = await roomRef.once('value');
    if (!snapshot.exists()) {
      alert("존재하지 않는 방이거나 연결 대기 중입니다.");
      showScreen('lobby');
      sessionStorage.removeItem('avalon_active_session');
      return;
    }

    roomRef.on('value', (snapshot) => {
      try {
        const data = snapshot.val();
        if (!data) return;

        gameState = data;
        
        if (gameState.players && gameState.players[mySessionId]) {
          myName = gameState.players[mySessionId].name;
          saveSessionToStorage(formattedRoomId, isHost);
        }

        if (gameState.phase === 'LOBBY') {
          showScreen('room');
          renderWaitingList();
        } else {
          showScreen('game');
          renderGameUI();
        }
      } catch(e) {
        console.error('DB 업데이트 처리 오류:', e);
      }
    });
  } catch(e) {
    console.error('startRoomListing 오류:', e);
    alert('방 연결 중 오류: ' + e.message);
  }
}

async function initializeRoomOnDB(roomId) {
  try {
    const roomRef = database.ref('rooms/' + roomId);
    await roomRef.set({
      roomId: roomId,
      phase: 'LOBBY',
      players: {
        [mySessionId]: { name: myName, joinedAt: Date.now(), status: 'active' }
      },
      logs: ["방이 생성되었습니다. 참가자를 기다립니다."]
    });
  } catch(e) {
    console.error('방 생성 오류:', e);
    alert('방 생성 실패: ' + e.message);
    throw e;
  }
}

function saveSessionToStorage(roomId, hostFlag) {
  sessionStorage.setItem('avalon_active_session', JSON.stringify({
    name: myName,
    roomId: roomId.toUpperCase(),
    isHost: hostFlag
  }));
}

// --- UI 렌더링 ---
function showScreen(screenName) {
  try {
    Object.values(screens).forEach(s => s.classList.add('hidden'));
    screens[screenName].classList.remove('hidden');
    if (screenName === 'room') {
      displays.roomId.innerText = gameState.roomId.toUpperCase();
      if (typeof generateQRCode === 'function') {
        generateQRCode(gameState.roomId.toUpperCase());
      }
      if (isHost) {
        document.getElementById('host-controls').classList.remove('hidden');
        document.getElementById('client-wait-msg').classList.add('hidden');
      } else {
        document.getElementById('host-controls').classList.add('hidden');
        document.getElementById('client-wait-msg').classList.remove('hidden');
      }
    }
  } catch(e) {
    console.error('showScreen 오류:', e);
  }
}

function renderWaitingList() {
  try {
    const players = gameState.players ? Object.values(gameState.players) : [];
    lists.waiting.innerHTML = players
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map(p => `<li class="player-item"><span>${p.name}</span></li>`)
      .join('');
    displays.playerCount.innerText = players.length;
  } catch(e) {
    console.error('renderWaitingList 오류:', e);
  }
}

function renderGameUI() {
  try {
    renderBoard();
    renderLogs();

    const restartBtn = document.getElementById('btn-host-restart');
    if (isHost) {
      restartBtn.classList.remove('hidden');
    } else {
      restartBtn.classList.add('hidden');
    }

    displays.rejectCount.innerText = gameState.rejectCount || 0;
    const leaderName = gameState.players[gameState.leaderSessionId]?.name || '-';
    displays.currentLeader.innerText = leaderName;

    const pEntries = gameState.players ? Object.entries(gameState.players) : [];
    lists.game.innerHTML = pEntries.map(([sId, p]) => {
      const isSelected = gameState.selectedTeam?.includes(sId);
      const isPlayerLeader = sId === gameState.leaderSessionId;
      const isMe = sId === mySessionId;
      
      let voteStatus = '';
      if (gameState.phase === 'TEAM_VOTE' && gameState.teamVotes?.[sId] !== undefined) {
        voteStatus = ' (투표완료)';
      }
      if (gameState.phase === 'MISSION_VOTE' && isSelected) {
        if (gameState.missionVotes?.[sId] !== undefined) voteStatus = ' (미션완료)';
      }

      return `
        <li class="player-item ${isSelected ? 'selected' : ''} ${isPlayerLeader ? 'leader' : ''}" 
            onclick="handlePlayerClick('${sId}')">
          <span>${p.name} ${isPlayerLeader ? '👑' : ''}${isMe ? ' (나)' : ''}${voteStatus}</span>
          ${isSelected ? '<span style="color:var(--gold); font-size:0.8rem;">[선발됨]</span>' : ''}
        </li>
      `;
    }).join('');

    renderActionArea();
  } catch(e) {
    console.error('renderGameUI 오류:', e);
  }
}

function renderBoard() {
  try {
    const playerCount = Object.keys(gameState.players).length;
    const reqs = QUEST_CONFIG[playerCount] || [2,3,2,3,3];
    const board = document.getElementById('quest-board');

    board.innerHTML = reqs.map((req, i) => {
      let statusClass = '';
      if (gameState.questResults?.[i] === true) statusClass = 'success';
      if (gameState.questResults?.[i] === false) statusClass = 'fail';
      if (i === gameState.currentQuest && gameState.phase !== 'GAME_OVER') statusClass += ' active';

      return `<div class="quest-slot ${statusClass}">${i+1}차<br>(${req}명)</div>`;
    }).join('');
  } catch(e) {
    console.error('renderBoard 오류:', e);
  }
}

function renderLogs() {
  try {
    if (!gameState.logs) return;
    lists.log.innerHTML = gameState.logs.slice(-20).map(m => `<div>• ${m}</div>`).join('');
    lists.log.scrollTop = lists.log.scrollHeight;
  } catch(e) {
    console.error('renderLogs 오류:', e);
  }
}

function renderActionArea() {
  try {
    const area = document.getElementById('action-area');
    const isLeader = gameState.leaderSessionId === mySessionId;
    const playerCount = Object.keys(gameState.players).length;
    const reqCount = QUEST_CONFIG[playerCount]?.[gameState.currentQuest];
    const myPlayer = gameState.players[mySessionId];

    if (!myPlayer || !myPlayer.role) {
      area.innerHTML = '<p style="text-align:center; color:var(--text-muted);">게임 데이터 로딩 중...</p>';
      return;
    }

    if (gameState.phase === 'TEAM_SELECTION') {
      if (isLeader) {
        const canSubmit = gameState.selectedTeam?.length === reqCount;
        area.innerHTML = `
          <p style="margin-bottom:8px;">원정대원 ${reqCount}명을 선택하세요.</p>
          <button class="btn btn-primary" ${canSubmit ? '' : 'disabled'} onclick="submitTeamProposal()">팀 구성 완료 및 투표 요청</button>
        `;
      } else {
        area.innerHTML = `<p style="text-align:center; color:var(--text-muted);">원정대장(${gameState.players[gameState.leaderSessionId]?.name || '?'})이 팀 구성 중입니다...</p>`;
      }
    } else if (gameState.phase === 'TEAM_VOTE') {
      const hasVoted = gameState.teamVotes?.[mySessionId] !== undefined;
      let statusMsg = '';
      if (hasVoted) {
        const myVote = gameState.teamVotes[mySessionId];
        statusMsg = myVote 
          ? `<div class="vote-status-badge approved">✔ [찬성] 선택함 (결과 대기 중)</div>`
          : `<div class="vote-status-badge rejected">✖ [반대] 선택함 (결과 대기 중)</div>`;
      }
      area.innerHTML = `
        <p style="margin-bottom:8px;">지목된 팀 찬반 투표</p>
        <div style="display:flex; gap:8px;">
          <button class="btn btn-blue" ${hasVoted ? 'disabled' : ''} onclick="voteTeam(true)">찬성</button>
          <button class="btn btn-danger" ${hasVoted ? 'disabled' : ''} onclick="voteTeam(false)">반대</button>
        </div>
        <div style="text-align:center; margin-top:8px;">${statusMsg}</div>
      `;
    } else if (gameState.phase === 'MISSION_VOTE') {
      const isTeamMember = gameState.selectedTeam?.includes(mySessionId);
      const hasVoted = gameState.missionVotes?.[mySessionId] !== undefined;

      if (isTeamMember) {
        area.innerHTML = `
          <p style="margin-bottom:8px; color:var(--gold);">[원정대원 전용] 임무 성공/실패 선택</p>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-blue" ${hasVoted ? 'disabled' : ''} onclick="voteMission(true)">임무 성공</button>
            <button class="btn btn-danger" ${hasVoted ? 'disabled' : ''} onclick="voteMission(false)">임무 실패</button>
          </div>
          ${hasVoted ? '<p style="text-align:center; margin-top:8px; color:var(--gold);">투표 완료. 다른 대원을 기다립니다...</p>' : ''}
        `;
      } else {
        area.innerHTML = `<p style="text-align:center; color:var(--text-muted);">원정대가 임무 수행 중입니다...</p>`;
      }
    } else if (gameState.phase === 'ASSASSINATE') {
      if (myPlayer.role === 'Assassin') {
        area.innerHTML = `<p style="color:var(--red);">머린으로 의심되는 플레이어를 목록에서 클릭하여 암살하세요!</p>`;
      } else {
        area.innerHTML = `<p style="text-align:center; color:var(--red);">선 세력 3승! 암살자가 머린을 찾는 중입니다...</p>`;
      }
    } else if (gameState.phase === 'GAME_OVER') {
      const isGoodWin = gameState.winner === 'GOOD';
      let restartBtnHTML = '';
      if (isHost) {
        restartBtnHTML = `<button class="btn btn-primary" style="margin-top:12px;" onclick="restartGame()">게임 다시하기 (대기실 이동)</button>`;
      } else {
        restartBtnHTML = `<p style="text-align:center; font-size:0.85rem; color:var(--text-muted); margin-top:12px;">방장이 다시하기를 누르기를 기다리고 있습니다...</p>`;
      }

      area.innerHTML = `
        <h2 style="text-align:center; color:${isGoodWin ? 'var(--blue)' : 'var(--red)'}">
          ${isGoodWin ? '정의의 세력 승리!' : '악의 세력 승리!'}
        </h2>
        ${restartBtnHTML}
      `;
    }
  } catch(e) {
    console.error('renderActionArea 오류:', e);
  }
}

// --- 액션 처리 함수 ---
window.createRoom = async function() {
  try {
    myName = inputs.name.value.trim();
    const pwd = inputs.createPassword.value.trim();

    if (!myName) return alert('닉네임을 입력하세요.');
    if (!pwd) return alert('키를 입력하세요.');
    if (pwd !== didyou) {
      alert('키가 일치하지 않습니다. 방을 만들 수 없습니다.');
      return;
    }

    const randomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
    const roomId = "ROOM_" + randomCode;
    isHost = true;
    
    await initializeRoomOnDB(roomId);
    inputs.name.disabled = true;
    saveSessionToStorage(roomId, isHost);
    await startRoomListing(roomId);

  } catch(e) {
    console.error('createRoom 오류:', e);
    alert('방 생성 오류: ' + e.message);
  }
};

window.joinGame = async function() {
  try {
    myName = inputs.name.value.trim();
    let rawInput = inputs.roomId.value.trim();
    if (!myName || !rawInput) return alert('닉네임과 방 코드를 입력하세요.');

    rawInput = rawInput.replace(/^room_/i, '');
    const roomId = "ROOM_" + rawInput.toUpperCase();

    isHost = false;
    await switchToRoomUI(roomId, isHost);
  } catch(e) {
    console.error('joinGame 오류:', e);
    alert('입장 오류: ' + e.message);
  }
};

async function switchToRoomUI(roomId, hostFlag) {
  try {
    inputs.name.disabled = true;
    
    if (!hostFlag) {
      const playerRef = database.ref(`rooms/${roomId}/players/${mySessionId}`);
      await playerRef.set({ name: myName, joinedAt: Date.now(), status: 'active' });
    }
    
    saveSessionToStorage(roomId, hostFlag);
    await startRoomListing(roomId);
  } catch(e) {
    console.error('switchToRoomUI 오류:', e);
    inputs.name.disabled = false;
    throw e;
  }
}

window.startGame = async function() {
  try {
    if (!isHost) return;
    
    const roomRef = database.ref('rooms/' + gameState.roomId);
    const snapshot = await roomRef.once('value');
    const latestData = snapshot.val();
    
    if (!latestData || !latestData.players) {
      alert('방 데이터를 찾을 수 없습니다.');
      return;
    }
    
    const pIds = Object.keys(latestData.players);
    const count = pIds.length;
    
    if (count < 5 || count > 10) {
      alert(`5~10명이어야 합니다. (현재: ${count}명)`);
      return;
    }

    const rolesConfig = {
      percival: document.getElementById('role-percival').checked,
      morgana: document.getElementById('role-morgana').checked,
      mordred: document.getElementById('role-mordred').checked,
      oberon: document.getElementById('role-oberon').checked,
    };

    let evilCount = 2;
    if (count >= 7) evilCount = 3;
    if (count >= 9) evilCount = 4;

    let roles = ['Merlin', 'Assassin'];
    let goodCount = count - evilCount - 1;
    let remainingEvil = evilCount - 1;

    if (rolesConfig.percival && goodCount > 0) { roles.push('Percival'); goodCount--; }
    if (rolesConfig.morgana && remainingEvil > 0) { roles.push('Morgana'); remainingEvil--; }
    if (rolesConfig.mordred && remainingEvil > 0) { roles.push('Mordred'); remainingEvil--; }
    if (rolesConfig.oberon && remainingEvil > 0) { roles.push('Oberon'); remainingEvil--; }

    while (goodCount > 0) { roles.push('Servant'); goodCount--; }
    while (remainingEvil > 0) { roles.push('Minion'); remainingEvil--; }

    const shuffledRoles = secureShuffle(roles);
    const shuffledPIds = secureShuffle(pIds);

    const playersUpdate = {};
    const leaderIndex = Math.floor(Math.random() * count);
    
    shuffledPIds.forEach((sId, i) => {
      playersUpdate[`players/${sId}/role`] = shuffledRoles[i];
    });

    await roomRef.update({
      ...playersUpdate,
      phase: 'TEAM_SELECTION',
      currentQuest: 0,
      questResults: [],
      rejectCount: 0,
      leaderSessionId: shuffledPIds[leaderIndex],
      logs: ["게임이 시작되었습니다! 역할 정보를 확인하고 리더는 팀을 구성하세요."],
      teamVotes: null,
      missionVotes: null,
      selectedTeam: null
    });
  } catch(e) {
    console.error('startGame 오류:', e);
    alert('게임 시작 오류: ' + e.message);
  }
};

window.restartGame = async function() {
  try {
    if (!isHost) {
      alert('방장만 강제 다시시작을 실행할 수 있습니다.');
      return;
    }

    if (!confirm('게임을 초기화하고 대기실 화면으로 이동하시겠습니까?')) return;
    
    const roomRef = database.ref('rooms/' + gameState.roomId);
    const snapshot = await roomRef.once('value');
    const latestData = snapshot.val();
    
    if (!latestData || !latestData.players) return;

    const playerUpdates = {};
    Object.keys(latestData.players).forEach(sId => {
      playerUpdates[`players/${sId}/role`] = null;
    });

    await roomRef.update({
      ...playerUpdates,
      phase: 'LOBBY',
      winner: null,
      currentQuest: 0,
      rejectCount: 0,
      selectedTeam: null,
      teamVotes: null,
      missionVotes: null,
      questResults: null,
      leaderSessionId: null,
      logs: ["방장에 의해 게임이 초기화되었습니다. 대기실에서 다시 게임을 설정하세요."]
    });
  } catch(e) {
    console.error('restartGame 오류:', e);
    alert('게임 초기화 오류: ' + e.message);
  }
};

window.handlePlayerClick = async function(targetSessionId) {
  try {
    if (gameState.phase === 'TEAM_SELECTION') {
      if (gameState.leaderSessionId === mySessionId) {
        const roomRef = database.ref('rooms/' + gameState.roomId);
        let currentTeam = gameState.selectedTeam ? [...gameState.selectedTeam] : [];
        const idx = currentTeam.indexOf(targetSessionId);
        const reqCount = QUEST_CONFIG[Object.keys(gameState.players).length][gameState.currentQuest];
        
        if (idx > -1) {
          currentTeam.splice(idx, 1);
        } else {
          if (currentTeam.length < reqCount) {
            currentTeam.push(targetSessionId);
          }
        }
        await roomRef.update({ selectedTeam: currentTeam });
      }
    } else if (gameState.phase === 'ASSASSINATE') {
      const myPlayer = gameState.players[mySessionId];
      if (myPlayer.role === 'Assassin') {
        const targetName = gameState.players[targetSessionId].name;
        if (confirm(`${targetName} 님을 머린으로 지목하고 암살하시겠습니까?`)) {
          submitAssassination(targetSessionId);
        }
      }
    }
  } catch(e) {
    console.error('handlePlayerClick 오류:', e);
  }
};

window.submitTeamProposal = async function() {
  try {
    if (gameState.leaderSessionId !== mySessionId) return;
    const roomRef = database.ref('rooms/' + gameState.roomId);
    await roomRef.update({ 
      phase: 'TEAM_VOTE', 
      teamVotes: null,
      logs: [...(gameState.logs||[]), "리더가 원정대 구성을 완료했습니다. 찬반 투표를 시작합니다."]
    });
  } catch(e) {
    console.error('submitTeamProposal 오류:', e);
  }
};

window.voteTeam = async function(vote) {
  try {
    if (gameState.phase !== 'TEAM_VOTE') return;
    if (gameState.teamVotes?.[mySessionId] !== undefined) return;

    const roomRef = database.ref('rooms/' + gameState.roomId);
    await roomRef.update({ [`teamVotes/${mySessionId}`]: vote });

    const snapshot = await roomRef.once('value');
    const latestData = snapshot.val();
    const pIds = Object.keys(latestData.players);
    const votesIds = latestData.teamVotes ? Object.keys(latestData.teamVotes) : [];

    if (votesIds.length === pIds.length) {
      processTeamVoteResult(latestData);
    }
  } catch(e) {
    console.error('voteTeam 오류:', e);
  }
};

async function processTeamVoteResult(data) {
  try {
    const approves = Object.values(data.teamVotes).filter(v => v).length;
    const rejects = Object.values(data.teamVotes).length - approves;
    const roomRef = database.ref('rooms/' + data.roomId);
    const currentLogs = data.logs || [];

    if (approves > rejects) {
      await roomRef.update({
        phase: 'MISSION_VOTE',
        missionVotes: null,
        rejectCount: 0,
        logs: [...currentLogs, `[표결 가결] 찬성 ${approves}표 / 반대 ${rejects}표. 원정을 출발합니다!`]
      });
    } else {
      const nextRejectCount = data.rejectCount + 1;
      if (nextRejectCount >= 5) {
        await roomRef.update({
          phase: 'GAME_OVER',
          winner: 'EVIL',
          logs: [...currentLogs, `[표결 부결] 찬성 ${approves}표 / 반대 ${rejects}표. (연속 부결 5회)`, "5회 연속 부결로 인해 악의 세력이 승리했습니다!"]
        });
      } else {
        const pIds = Object.keys(data.players);
        const currentLeaderIdx = pIds.indexOf(data.leaderSessionId);
        const nextLeaderIdx = (currentLeaderIdx + 1) % pIds.length;

        await roomRef.update({
          phase: 'TEAM_SELECTION',
          leaderSessionId: pIds[nextLeaderIdx],
          rejectCount: nextRejectCount,
          selectedTeam: null,
          logs: [...currentLogs, `[표결 부결] 찬성 ${approves}표 / 반대 ${rejects}표. (연속 부결 ${nextRejectCount}회)`, `다음 원정대장(${data.players[pIds[nextLeaderIdx]].name})에게 기회가 넘어갑니다.`]
        });
      }
    }
  } catch(e) {
    console.error('processTeamVoteResult 오류:', e);
  }
}

window.voteMission = async function(vote) {
  try {
    if (gameState.phase !== 'MISSION_VOTE') return;
    if (!gameState.selectedTeam?.includes(mySessionId)) return;
    if (gameState.missionVotes?.[mySessionId] !== undefined) return;

    const myPlayer = gameState.players[mySessionId];
    const isEvil = ['Assassin', 'Morgana', 'Mordred', 'Oberon', 'Minion'].includes(myPlayer.role);
    if (!vote && !isEvil) {
      alert("정의의 세력은 실패를 제출할 수 없습니다!");
      return;
    }

    const roomRef = database.ref('rooms/' + gameState.roomId);
    await roomRef.update({ [`missionVotes/${mySessionId}`]: vote });

    const snapshot = await roomRef.once('value');
    const latestData = snapshot.val();
    const votesIds = latestData.missionVotes ? Object.keys(latestData.missionVotes) : [];
    const teamCount = latestData.selectedTeam?.length || 0;

    if (votesIds.length === teamCount) {
      processMissionResult(latestData);
    }
  } catch(e) {
    console.error('voteMission 오류:', e);
  }
};

async function processMissionResult(data) {
  try {
    const fails = Object.values(data.missionVotes).filter(v => !v).length;
    const playerCount = Object.keys(data.players).length;
    
    let requiredFails = 1;
    if (playerCount >= 7 && data.currentQuest === 3) {
      requiredFails = 2;
    }

    const isSuccess = fails < requiredFails;
    const currentQuestResults = data.questResults ? [...data.questResults] : [];
    currentQuestResults.push(isSuccess);

    const roomRef = database.ref('rooms/' + data.roomId);
    const currentLogs = data.logs || [];
    const pIds = Object.keys(data.players);

    const resultLog = isSuccess ? "성공했습니다." : "실패했습니다.";
    currentLogs.push(`${data.currentQuest + 1}차 원정 결과: ${resultLog} (실패 표: ${fails}장)`);

    const wins = currentQuestResults.filter(r => r).length;
    const losses = currentQuestResults.filter(r => !r).length;

    if (wins >= 3) {
      await roomRef.update({
        questResults: currentQuestResults,
        phase: 'ASSASSINATE',
        missionVotes: null,
        logs: [...currentLogs, "정의의 세력이 3번 성공했습니다! 암살자 단계를 진행합니다."]
      });
    } else if (losses >= 3) {
      await roomRef.update({
        questResults: currentQuestResults,
        phase: 'GAME_OVER',
        winner: 'EVIL',
        logs: [...currentLogs, "악의 세력이 3번 실패를 이끌어내어 승리했습니다!"]
      });
    } else {
      const currentLeaderIdx = pIds.indexOf(data.leaderSessionId);
      const nextLeaderIdx = (currentLeaderIdx + 1) % pIds.length;
      
      await roomRef.update({
        questResults: currentQuestResults,
        phase: 'TEAM_SELECTION',
        leaderSessionId: pIds[nextLeaderIdx],
        currentQuest: data.currentQuest + 1,
        selectedTeam: null,
        missionVotes: null,
        logs: [...currentLogs, `다음 원정대장(${data.players[pIds[nextLeaderIdx]].name})에게 기회가 넘어갑니다.`]
      });
    }
  } catch(e) {
    console.error('processMissionResult 오류:', e);
  }
}

async function submitAssassination(targetSessionId) {
  try {
    if (gameState.phase !== 'ASSASSINATE') return;
    
    const target = gameState.players[targetSessionId];
    const roomRef = database.ref('rooms/' + gameState.roomId);
    const currentLogs = gameState.logs || [];

    if (target.role === 'Merlin') {
      await roomRef.update({
        phase: 'GAME_OVER',
        winner: 'EVIL',
        logs: [...currentLogs, `[암살 성공] 암살자가 머린(${target.name})을 맞추었습니다!`, "악의 세력이 최종 승리했습니다!"]
      });
    } else {
      await roomRef.update({
        phase: 'GAME_OVER',
        winner: 'GOOD',
        logs: [...currentLogs, `[암살 실패] 지목한 사람(${target.name})은 머린이 아닙니다.`, "정의의 세력이 최종 승리했습니다!"]
      });
    }
  } catch(e) {
    console.error('submitAssassination 오류:', e);
  }
}

// --- 비밀 시야 ---
window.revealSecret = function() {
  try {
    const myPlayer = gameState.players[mySessionId];
    if (!myPlayer || !myPlayer.role || gameState.phase === 'LOBBY') return;
    
    displays.secretHint.classList.add('hidden');
    displays.secretContent.classList.remove('hidden');

    let text = `역할: <strong>${getRoleKorean(myPlayer.role)}</strong><br>`;
    text += `<small style="color:var(--text-muted);">${getRoleVision(myPlayer)}</small>`;
    displays.secretContent.innerHTML = text;
  } catch(e) {
    console.error('revealSecret 오류:', e);
  }
};

window.hideSecret = function() {
  try {
    displays.secretHint.classList.remove('hidden');
    displays.secretContent.classList.add('hidden');
  } catch(e) {
    console.error('hideSecret 오류:', e);
  }
};

function getRoleKorean(role) {
  const map = {
    Merlin: '머린 (선)', Assassin: '암살자 (악)', Percival: '퍼시벌 (선)',
    Morgana: '모거나 (악)', Mordred: '모드레드 (악)', Oberon: '오베론 (악)',
    Servant: '시종 (선)', Minion: '악의 무리 (악)'
  };
  return map[role] || role;
}

function getRoleVision(myPlayer) {
  try {
    const role = myPlayer.role;
    const allPlayers = Object.values(gameState.players);
    const evilsExceptMordred = allPlayers.filter(p => ['Assassin', 'Morgana', 'Minion', 'Oberon'].includes(p.role) && p.role !== 'Mordred');
    const evilsExceptOberon = allPlayers.filter(p => ['Assassin', 'Morgana', 'Minion', 'Mordred'].includes(p.role));
    const merlinCandidates = allPlayers.filter(p => p.role === 'Merlin' || p.role === 'Morgana');

    if (role === 'Merlin') {
      return `악의 무리 확인(오베론 포함/모드레드 제외): ` + evilsExceptMordred.map(p => p.name).join(', ');
    } else if (['Assassin', 'Morgana', 'Minion', 'Mordred'].includes(role)) {
      const teammates = evilsExceptOberon.filter(p => p.name !== myPlayer.name);
      return `동료 악 세력(모드레드 포함/오베론 제외): ` + (teammates.map(p => p.name).join(', ') || '없음');
    } else if (role === 'Percival') {
      return `머린 후보 (머린/모거나): ` + merlinCandidates.map(p => p.name).join(', ');
    }
    return `정보가 없습니다. 발언에 집중하세요.`;
  } catch(e) {
    console.error('getRoleVision 오류:', e);
    return '정보 조회 오류';
  }
}
