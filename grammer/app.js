// 영어 문법 개념 학습 - 문제은행 + (선택) 로컬 LLM 하이브리드
// 데이터: data/concepts_<영역>.json, data/questions_<영역>.json

(function () {
  'use strict';

  // ---------- 설정 ----------
  const AREAS = [
    { code: 'S', title: '문장의 뼈대', ready: false },
    { code: 'T', title: '동사의 시간', ready: true },
    { code: 'A', title: '동사의 태도', ready: false },
    { code: 'P', title: '동사의 방향', ready: false },
    { code: 'N', title: '명사 주변', ready: false },
    { code: 'D', title: '꾸미는 말', ready: false },
    { code: 'V', title: '준동사', ready: false },
    { code: 'C', title: '문장 연결', ready: false },
    { code: 'X', title: '특수 구문', ready: false }
  ];
  const LEVELS = { E: '초등', M: '중등', H: '고등' };
  const LEVEL_ORDER = { E: 0, M: 1, H: 2 };
  const REVIEW_DAYS = [1, 3, 7];      // 오답 복습 간격 (일)
  const DAY = 24 * 60 * 60 * 1000;
  const STORE_KEY = 'grammar.v1';

  // ---------- 저장 ----------
  const defaultState = () => ({
    level: 'M',
    progress: {},   // conceptId -> { status: 'good'|'warn'|'none', best, attempts }
    notes: {},      // conceptId -> 학생이 쓴 한 줄 정리
    review: {},     // questionId -> { box, due }
    mis: {},        // misconceptionId -> 틀린 횟수
    llmUrl: '',
    llmModel: ''
  });

  let state = defaultState();
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved) state = Object.assign(defaultState(), saved);
  } catch (e) { /* 저장소를 쓸 수 없으면 기본값으로 진행 */ }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* 무시 */ }
  }

  // ---------- 데이터 ----------
  const cache = {};
  async function loadArea(code) {
    if (cache[code]) return cache[code];
    const [c, q] = await Promise.all([
      fetch(`data/concepts_${code}.json`).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
      fetch(`data/questions_${code}.json`).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    ]);
    const area = {
      code, title: c.title, intro: c.intro,
      concepts: c.concepts,
      questions: q.questions,
      conceptMap: {}, misMap: {}, questionMap: {}
    };
    area.concepts.forEach(con => {
      area.conceptMap[con.id] = con;
      con.misconceptions.forEach(m => { area.misMap[m.id] = m; });
    });
    area.questions.forEach(qq => { area.questionMap[qq.id] = qq; });
    cache[code] = area;
    return area;
  }
  async function loadReadyAreas() {
    return Promise.all(AREAS.filter(a => a.ready).map(a => loadArea(a.code)));
  }
  const areaOf = id => id.split('.')[0];

  // ---------- 도우미 ----------
  const app = document.getElementById('app');
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const levelBadge = lv => `<span class="badge level">${esc(LEVELS[lv] || lv)}</span>`;
  const STATUS_TEXT = { good: '이해함', warn: '흔들림', none: '아직' };
  function statusOf(id) { return (state.progress[id] && state.progress[id].status) || 'none'; }
  function statusBadge(id) {
    const s = statusOf(id);
    const cls = s === 'good' ? 'good' : s === 'warn' ? 'warn' : '';
    return `<span class="badge ${cls}">${STATUS_TEXT[s]}</span>`;
  }
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  // 개념의 단계 중 학생 단계 이하인 것들 (없으면 가장 낮은 단계 하나)
  function levelsFor(concept) {
    const keys = Object.keys(concept.levels).sort((a, b) => LEVEL_ORDER[a] - LEVEL_ORDER[b]);
    const mine = keys.filter(k => LEVEL_ORDER[k] <= LEVEL_ORDER[state.level]);
    return { keys: mine.length ? mine : [keys[0]], aboveMe: mine.length === 0, lowest: keys[0] };
  }
  function questionsFor(area, conceptId) {
    const all = area.questions.filter(q => q.concept === conceptId);
    const mine = all.filter(q => LEVEL_ORDER[q.level] <= LEVEL_ORDER[state.level]);
    return mine.length ? mine : all;
  }
  function dueReviews() {
    const now = Date.now();
    return Object.keys(state.review).filter(id => state.review[id].due <= now);
  }
  function updateNav() {
    const n = dueReviews().length;
    document.getElementById('nav-review').innerHTML = '복습' + (n ? `<span class="count">${n}</span>` : '');
  }

  // ---------- 홈 ----------
  async function renderHome() {
    const areas = await loadReadyAreas();
    const due = dueReviews().length;
    let html = `<h1>개념 지도</h1>
      <p class="sub">지금 단계: ${levelBadge(state.level)} <a href="#/settings">바꾸기</a></p>`;
    if (due) {
      html += `<div class="card"><h3>오늘 복습할 문제 ${due}개</h3>
        <p class="sub">전에 틀린 문제를 다시 풀어 개념을 단단하게 만들어요.</p>
        <a class="btn" href="#/review">복습 시작</a></div>`;
    }
    areas.forEach(area => {
      html += `<div class="card"><div class="area-head"><h2>${esc(area.title)}</h2></div>
        <p class="sub">${esc(area.intro)}</p>
        <div class="legend"><span><i class="dot good"></i>이해함</span><span><i class="dot warn"></i>흔들림</span><span><i class="dot"></i>아직</span></div>
        <ul class="concept-list">`;
      area.concepts.forEach(c => {
        const lv = levelsFor(c);
        html += `<li><a href="#/learn/${esc(c.id)}">
          <i class="dot ${statusOf(c.id) === 'none' ? '' : statusOf(c.id)}"></i>
          <span class="name ${lv.aboveMe ? 'locked' : ''}">${esc(c.name)}</span>
          ${levelBadge(lv.lowest)}</a></li>`;
      });
      html += `</ul></div>`;
    });
    const soon = AREAS.filter(a => !a.ready).map(a => a.title).join(', ');
    html += `<p class="areas-soon">준비 중인 영역: ${esc(soon)}</p>`;
    app.innerHTML = html;
  }

  // ---------- 그림 (시간선 / 묶음) ----------
  // timeline 표시 종류
  //   point: 한 시점의 일        { at, label, sub, row }
  //   dots : 반복되는 일          { at: [..], label, sub, row }
  //   wave : 진행 중인 일 (물결)   { from, to, arrow?, label, sub, row }
  //   arrow: 이어짐·연결           { from, to, label?, sub?, row }
  //   ref  : 기준 시점 (점선)      { at, label, sub }  → 라벨은 시간선 아래
  // at/from/to: '지금'=0, 과거는 음수, 미래는 양수 (-3.5 ~ 3.5)
  // row: 라벨 높이 (0 = 시간선 가까이, 1 = 위쪽)
  const TL = { w: 360, h: 196, axisY: 128, unit: 44, cx: 180 };
  const tx = at => TL.cx + at * TL.unit;
  const rowY = row => (row ? 24 : 72);

  function svgLabel(x, y, label, sub, color) {
    // 가장자리에서 글자가 잘리지 않도록 정렬 기준을 바꿈
    let anchor = 'middle';
    let ax = x;
    if (x < 90) { anchor = 'start'; ax = Math.max(6, x - 12); }
    else if (x > TL.w - 90) { anchor = 'end'; ax = Math.min(TL.w - 6, x + 12); }
    let s = '';
    if (label) s += `<text x="${ax}" y="${y}" text-anchor="${anchor}" class="tl-en" fill="${color || '#1f2430'}">${esc(label)}</text>`;
    if (sub) s += `<text x="${ax}" y="${y + 19}" text-anchor="${anchor}" class="tl-ko">${esc(sub)}</text>`;
    return s;
  }

  function wavePath(x1, x2, y) {
    const amp = 5, half = 7;
    let d = `M ${x1} ${y}`;
    let up = true;
    for (let x = x1; x < x2; x += half) {
      const nx = Math.min(x + half, x2);
      d += ` Q ${(x + nx) / 2} ${up ? y - amp * 2 : y + amp * 2} ${nx} ${y}`;
      up = !up;
    }
    return d;
  }

  function renderTimeline(marks) {
    const y = TL.axisY;
    let back = '', front = '', labels = '';
    marks.forEach(m => {
      if (m.type === 'ref') {
        const x = tx(m.at);
        back += `<line x1="${x}" y1="${y - 32}" x2="${x}" y2="${y + 10}" class="tl-ref"/>`;
        labels += svgLabel(x, y + 34, m.label, m.sub, '#6b7280');
      } else if (m.type === 'point') {
        const x = tx(m.at);
        front += `<circle cx="${x}" cy="${y}" r="7" class="tl-point"/>`;
        labels += svgLabel(x, rowY(m.row), m.label, m.sub);
      } else if (m.type === 'dots') {
        m.at.forEach(a => { front += `<circle cx="${tx(a)}" cy="${y}" r="5" class="tl-point"/>`; });
        labels += svgLabel(tx(0), rowY(m.row), m.label, m.sub);
      } else if (m.type === 'wave') {
        const x1 = tx(m.from), x2 = tx(m.to);
        front += `<path d="${wavePath(x1, x2, y - 14)}" class="tl-wave" ${m.arrow ? 'marker-end="url(#tl-head-w)"' : ''}/>`;
        labels += svgLabel((x1 + x2) / 2, rowY(m.row), m.label, m.sub);
      } else if (m.type === 'arrow') {
        const x1 = tx(m.from), x2 = tx(m.to);
        front += `<line x1="${x1}" y1="${y - 16}" x2="${x2 - 6}" y2="${y - 16}" class="tl-arrow" marker-end="url(#tl-head)"/>`;
        if (m.label || m.sub) labels += svgLabel((x1 + x2) / 2, rowY(m.row), m.label, m.sub);
      }
    });
    const now = tx(0);
    return `<svg class="timeline" viewBox="0 0 ${TL.w} ${TL.h}" role="img" aria-label="시간선 그림">
      <defs>
        <marker id="tl-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#3b5bdb"/></marker>
        <marker id="tl-head-w" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#e8590c"/></marker>
        <marker id="tl-axis" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#adb5bd"/></marker>
      </defs>
      ${back}
      <line x1="8" y1="${y}" x2="${TL.w - 8}" y2="${y}" class="tl-axis" marker-end="url(#tl-axis)"/>
      <line x1="${now}" y1="${y - 8}" x2="${now}" y2="${y + 8}" class="tl-now"/>
      <text x="${now}" y="${y + 28}" text-anchor="middle" class="tl-now-text">지금</text>
      <text x="10" y="${y + 28}" class="tl-side">과거</text>
      <text x="${TL.w - 10}" y="${y + 28}" text-anchor="end" class="tl-side">미래</text>
      ${front}${labels}
    </svg>`;
  }

  function renderGroups(groups) {
    return `<div class="groups" style="grid-template-columns: repeat(${groups.length}, 1fr)">${groups.map(g => `
      <div class="group ${g.tone === 'good' ? 'good' : ''}">
        <div class="group-title">${esc(g.title)}</div>
        ${g.items.map(it => `<div class="group-item">${esc(it)}</div>`).join('')}
        ${g.example ? `<div class="group-ex">${esc(g.example)}</div>` : ''}
      </div>`).join('')}</div>`;
  }

  function renderDiagram(lv) {
    let html = '';
    if (lv.timeline) html += renderTimeline(lv.timeline);
    if (lv.groups) html += renderGroups(lv.groups);
    if (lv.diagram) html += `<p class="diagram-caption">${esc(lv.diagram)}</p>`;
    return html;
  }

  // ---------- 개념 학습 ----------
  function buildSteps(concept) {
    const lv = levelsFor(concept);
    const base = concept.levels[lv.keys[0]];
    const steps = [];
    if (base.why) steps.push({ label: '왜 필요할까?', html: `<p>${esc(base.why)}</p>` });
    if (base.core) steps.push({ label: '핵심 한 문장', html: `<p class="core">${esc(base.core)}</p>` });
    if (base.diagram || base.timeline || base.groups) {
      steps.push({ label: '그림으로 보기', html: renderDiagram(base) });
    }
    if (base.examples && base.examples.length) {
      steps.push({
        label: '예문',
        html: base.examples.map(e => `<div class="example"><div class="en">${esc(e.en)}</div><div class="ko">${esc(e.ko)}</div></div>`).join('')
      });
    }
    const contrastStep = ct => ({
      label: '헷갈리는 것과 비교',
      html: `<div class="contrast">
        <div><div class="en">${esc(ct.a.en)}</div><div class="ko">${esc(ct.a.ko)}</div></div>
        <div><div class="en">${esc(ct.b.en)}</div><div class="ko">${esc(ct.b.ko)}</div></div>
      </div><div class="point">${esc(ct.point)}</div>`
    });
    // 기본 단계의 대비와 추가 설명을 먼저
    if (base.contrast) steps.push(contrastStep(base.contrast));
    if (base.extra) steps.push({ label: '더 알아두기', html: `<p>${esc(base.extra)}</p>` });
    // 학생 단계가 더 높으면 심화 내용과 그 단계의 대비를 이어서
    lv.keys.slice(1).forEach(k => {
      const more = concept.levels[k];
      let h = '';
      if (more.core) h += `<p class="core">${esc(more.core)}</p>`;
      if (more.extra) h += `<p>${esc(more.extra)}</p>`;
      if (h) steps.push({ label: `${LEVELS[k]} 심화`, html: h });
      if (more.contrast) steps.push(contrastStep(more.contrast));
    });
    return { steps, lv, base };
  }

  async function renderLearn(id, stepIdx) {
    const area = await loadArea(areaOf(id));
    const concept = area.conceptMap[id];
    if (!concept) { app.innerHTML = '<p>개념을 찾을 수 없어요.</p>'; return; }
    const { steps, lv, base } = buildSteps(concept);
    const total = steps.length + 1; // 마지막: 확인 문제로
    const i = Math.max(0, Math.min(stepIdx || 0, total - 1));

    const prereqs = concept.prerequisites.map(p => {
      const a = cache[areaOf(p)];
      const pc = a && a.conceptMap[p];
      return pc ? `<a href="#/learn/${esc(p)}">${esc(pc.name)}</a>${statusBadge(p)}` : `<span>${esc(p)}</span>`;
    }).join(' ');
    const weak = concept.prerequisites.filter(p => cache[areaOf(p)] && cache[areaOf(p)].conceptMap[p] && statusOf(p) !== 'good');

    let html = `<a href="#/">← 개념 지도</a>
      <h1>${esc(concept.name)}</h1>
      <p class="prereq">먼저 알아야 할 개념: ${prereqs || '없음'}</p>`;
    if (lv.aboveMe) {
      html += `<div class="notice">이 개념은 ${LEVELS[lv.lowest]} 단계예요. 지금 단계보다 높지만 미리 볼 수 있어요.</div>`;
    } else if (weak.length && i === 0) {
      html += `<div class="notice">먼저 알아야 할 개념 중 아직 '이해함'이 아닌 것이 있어요. 막히면 그 개념부터 확인해 보세요.</div>`;
    }
    html += `<div class="progress-steps">${Array.from({ length: total }, (_, k) => `<span class="${k <= i ? 'on' : ''}"></span>`).join('')}</div>`;

    if (i < steps.length) {
      const s = steps[i];
      html += `<div class="card"><div class="step-label">${esc(s.label)}</div>${s.html}</div>
        <div class="btn-row">
          <button class="btn ghost" ${i === 0 ? 'disabled' : ''} data-go="${i - 1}">이전</button>
          <button class="btn" data-go="${i + 1}">다음</button>
        </div>`;
    } else {
      html += `<div class="card"><div class="step-label">이해했는지 확인해요</div>
        <p>문제를 풀면서 개념이 잘 잡혔는지 확인해요. 틀리면 어떤 부분을 헷갈렸는지 알려 줄게요.</p>
        <a class="btn" href="#/quiz/${esc(id)}">확인 문제 풀기</a></div>
        <div class="btn-row"><button class="btn ghost" data-go="${i - 1}">이전</button></div>`;
    }
    app.innerHTML = html;
    app.querySelectorAll('[data-go]').forEach(b => {
      b.onclick = () => { location.hash = `#/learn/${id}/${b.dataset.go}`; };
    });
  }

  // ---------- 문제 풀이 ----------
  // session: { mode: 'quiz'|'review', conceptId, list, idx, answers: [{qid, correct, mis}] }
  let session = null;

  async function startQuiz(id) {
    const area = await loadArea(areaOf(id));
    const list = shuffle(questionsFor(area, id)).map(q => q.id);
    session = { mode: 'quiz', conceptId: id, list, idx: 0, answers: [] };
    renderQuestion();
  }

  async function startReview() {
    await loadReadyAreas();
    const list = shuffle(dueReviews().filter(qid => cache[areaOf(qid)] && cache[areaOf(qid)].questionMap[qid]));
    session = { mode: 'review', conceptId: null, list, idx: 0, answers: [] };
    if (!list.length) { renderReviewEmpty(); return; }
    renderQuestion();
  }

  function renderQuestion() {
    const qid = session.list[session.idx];
    const area = cache[areaOf(qid)];
    const q = area.questionMap[qid];
    const concept = area.conceptMap[q.concept];
    const opts = shuffle(q.options);
    const title = session.mode === 'review' ? '오답 복습' : esc(concept.name);

    app.innerHTML = `<a href="${session.mode === 'review' ? '#/' : '#/learn/' + esc(q.concept)}">← 그만하기</a>
      <h1>${title}</h1>
      <p class="sub">${session.idx + 1} / ${session.list.length}</p>
      <div class="card">
        <div class="q-meta">${levelBadge(q.level)}<span class="badge">${esc(concept.name)}</span></div>
        <div class="question">${esc(q.question)}</div>
        <div class="options">${opts.map(o => `<button class="option" data-id="${esc(o.id)}">${esc(o.text)}</button>`).join('')}</div>
        <div id="fb"></div>
      </div>`;

    app.querySelectorAll('.option').forEach(btn => {
      btn.onclick = () => answer(q, area, btn.dataset.id);
    });
  }

  function answer(q, area, optId) {
    const chosen = q.options.find(o => o.id === optId);
    const right = q.options.find(o => o.correct);
    const ok = !!chosen.correct;
    app.querySelectorAll('.option').forEach(b => {
      b.disabled = true;
      if (b.dataset.id === right.id) b.classList.add('correct');
      else if (b.dataset.id === optId) b.classList.add('wrong');
    });

    const mis = !ok && chosen.misconception ? area.misMap[chosen.misconception] || findMis(chosen.misconception) : null;
    session.answers.push({ qid: q.id, correct: ok, mis: mis ? mis.id : null });
    recordReview(q.id, ok);
    if (mis) state.mis[mis.id] = (state.mis[mis.id] || 0) + 1;
    save();

    let fb = `<div class="feedback ${ok ? 'good' : 'bad'}"><strong>${ok ? '맞았어요!' : '아쉬워요.'}</strong> ${esc(q.explanation)}`;
    if (mis) {
      fb += `<div class="mis">헷갈린 부분: ${esc(mis.desc)}<br>
        <span class="wrong-ex">${esc(mis.wrong)}</span> → <span class="right-ex">${esc(mis.right)}</span></div>`;
    }
    fb += `</div><div class="btn-row"><span></span><button class="btn" id="next">${session.idx + 1 < session.list.length ? '다음 문제' : '결과 보기'}</button></div>`;
    document.getElementById('fb').innerHTML = fb;
    document.getElementById('next').onclick = () => {
      session.idx++;
      if (session.idx < session.list.length) renderQuestion();
      else renderResult();
    };
  }

  function findMis(id) {
    const a = cache[areaOf(id)];
    return a ? a.misMap[id] : null;
  }

  // 오답은 복습 목록에 넣고, 복습에서 맞히면 간격을 늘려 가다가 졸업
  function recordReview(qid, ok) {
    const r = state.review[qid];
    if (!ok) {
      state.review[qid] = { box: 0, due: Date.now() + REVIEW_DAYS[0] * DAY };
    } else if (r && session.mode === 'review') {
      const box = r.box + 1;
      if (box >= REVIEW_DAYS.length) delete state.review[qid];
      else state.review[qid] = { box, due: Date.now() + REVIEW_DAYS[box] * DAY };
    }
  }

  function renderResult() {
    const total = session.answers.length;
    const correct = session.answers.filter(a => a.correct).length;
    const ratio = total ? correct / total : 0;
    const misIds = [...new Set(session.answers.filter(a => a.mis).map(a => a.mis))];

    let html = '';
    if (session.mode === 'quiz') {
      const id = session.conceptId;
      // 모두 맞히면 이해함, 절반 이상이면 흔들림, 그 아래는 아직
      const status = ratio === 1 ? 'good' : ratio >= 0.5 ? 'warn' : 'none';
      const p = state.progress[id] || { attempts: 0, best: 0 };
      state.progress[id] = { status, attempts: p.attempts + 1, best: Math.max(p.best || 0, ratio) };
      save();
      const concept = cache[areaOf(id)].conceptMap[id];
      html += `<a href="#/">← 개념 지도</a><h1>${esc(concept.name)} 결과</h1>
        <div class="card"><div class="result-score">${correct} / ${total}</div>
        <p>이 개념은 지금 ${statusBadge(id)} 상태예요.</p>
        ${status === 'good'
          ? '<p>개념이 잘 잡혔어요. 마지막으로 내 말로 정리해 보세요.</p>'
          : '<p>틀린 문제는 내일 복습 목록에 들어가요. 아래 헷갈린 부분을 확인하고 개념을 한 번 더 봐요.</p>'}
        </div>`;
    } else {
      html += `<a href="#/">← 개념 지도</a><h1>복습 결과</h1>
        <div class="card"><div class="result-score">${correct} / ${total}</div>
        <p>맞힌 문제는 복습 간격이 늘어나고, 세 번 연속 맞히면 복습 목록에서 빠져요.</p></div>`;
    }

    if (misIds.length) {
      html += `<div class="card"><h3>헷갈린 부분</h3><ul class="mis-list">${misIds.map(mid => {
        const m = findMis(mid);
        return m ? `<li>${esc(m.desc)}<br><span class="ko">${esc(m.wrong)} → ${esc(m.right)}</span></li>` : '';
      }).join('')}</ul></div>`;
    }

    if (session.mode === 'quiz') {
      html += renderSummaryBox(session.conceptId);
      html += `<div class="btn-row">
        <a class="btn ghost" href="#/learn/${esc(session.conceptId)}">개념 다시 보기</a>
        <a class="btn" href="#/quiz/${esc(session.conceptId)}">다시 풀기</a></div>`;
    }
    app.innerHTML = html;
    if (session.mode === 'quiz') bindSummaryBox(session.conceptId);
    updateNav();
  }

  function renderReviewEmpty() {
    const count = Object.keys(state.review).length;
    const top = Object.entries(state.mis).sort((a, b) => b[1] - a[1]).slice(0, 5);
    let html = `<a href="#/">← 개념 지도</a><h1>복습</h1>
      <div class="card"><p>지금 복습할 문제가 없어요.${count ? ` 복습 대기 중인 문제는 ${count}개예요.` : ''}</p></div>`;
    if (top.length) {
      html += `<div class="card"><h3>자주 헷갈리는 부분</h3><ul class="mis-list">${top.map(([mid, n]) => {
        const m = findMis(mid);
        return m ? `<li>${esc(m.desc)} <span class="badge warn">${n}번</span></li>` : '';
      }).join('')}</ul></div>`;
    }
    app.innerHTML = html;
  }

  // ---------- 스스로 정리 (+ 선택: LLM 피드백) ----------
  function renderSummaryBox(id) {
    const concept = cache[areaOf(id)].conceptMap[id];
    const lv = levelsFor(concept);
    const prompt = concept.levels[lv.keys[0]].summary_prompt || '이 개념을 내 말로 정리해 보세요.';
    return `<div class="card"><h3>내 말로 정리하기</h3>
      <p class="sub">${esc(prompt)}</p>
      <textarea id="summary" placeholder="예: 현재완료는 ...">${esc(state.notes[id] || '')}</textarea>
      <div class="btn-row">
        <button class="btn ghost" id="save-note">개념 노트에 저장</button>
        ${state.llmUrl ? '<button class="btn" id="ask-ai">AI에게 확인받기</button>' : ''}
      </div>
      <div id="ai-out"></div></div>`;
  }

  function bindSummaryBox(id) {
    const ta = document.getElementById('summary');
    document.getElementById('save-note').onclick = () => {
      state.notes[id] = ta.value.trim();
      save();
      document.getElementById('save-note').textContent = '저장했어요';
    };
    const ai = document.getElementById('ask-ai');
    if (ai) ai.onclick = () => askLLM(id, ta.value.trim());
  }

  // OpenAI 호환 API(Ollama 등)로 학생의 정리를 확인. 정답 기준은 검증된 개념 데이터로 넘겨줌.
  async function askLLM(id, text) {
    const out = document.getElementById('ai-out');
    if (!text) { out.innerHTML = '<div class="ai-box">먼저 정리를 써 주세요.</div>'; return; }
    const concept = cache[areaOf(id)].conceptMap[id];
    const lv = levelsFor(concept);
    const core = lv.keys.map(k => concept.levels[k].core).filter(Boolean).join(' ');
    const misList = concept.misconceptions.map(m => `- ${m.desc} (예: ${m.wrong} → ${m.right})`).join('\n');
    const system = [
      '너는 한국 학생의 영어 문법 개념 정리를 확인하는 선생님이야.',
      `학생 단계: ${LEVELS[state.level]}. 개념: ${concept.name}.`,
      `정답 기준(이것만 근거로 판단해): ${core}`,
      `자주 하는 오개념:\n${misList}`,
      '학생의 정리가 정답 기준과 맞는지 판단하고, 빠졌거나 틀린 부분을 짧게 알려 줘.',
      '정답 기준에 없는 새로운 규칙은 만들지 마. 한국어로 3문장 이내로 친절하게 답해.'
    ].join('\n');

    out.innerHTML = '<div class="ai-box">확인하는 중...</div>';
    try {
      const res = await fetch(state.llmUrl.replace(/\/$/, '') + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: state.llmModel || 'default',
          messages: [{ role: 'system', content: system }, { role: 'user', content: text }],
          temperature: 0.2
        })
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const reply = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      out.innerHTML = `<div class="ai-box">${esc(reply || '응답이 비어 있어요.')}</div>`;
    } catch (e) {
      out.innerHTML = `<div class="ai-box">AI 서버에 연결하지 못했어요. (${esc(e.message)}) 설정의 주소를 확인해 주세요. 문제 풀이와 복습은 AI 없이도 그대로 쓸 수 있어요.</div>`;
    }
  }

  // ---------- 개념 노트 ----------
  async function renderNotes() {
    await loadReadyAreas();
    const ids = Object.keys(state.notes).filter(id => state.notes[id]);
    let html = `<a href="#/">← 개념 지도</a><h1>개념 노트</h1>
      <p class="sub">문제를 푼 뒤 내 말로 정리한 내용이 모여요.</p>`;
    if (!ids.length) html += '<div class="card"><p>아직 저장한 정리가 없어요.</p></div>';
    ids.forEach(id => {
      const a = cache[areaOf(id)];
      const c = a && a.conceptMap[id];
      if (!c) return;
      html += `<div class="card"><h3><a href="#/learn/${esc(id)}">${esc(c.name)}</a> ${statusBadge(id)}</h3>
        <p>${esc(state.notes[id])}</p></div>`;
    });
    app.innerHTML = html;
  }

  // ---------- 설정 ----------
  function renderSettings() {
    app.innerHTML = `<a href="#/">← 개념 지도</a><h1>설정</h1>
      <div class="card">
        <label for="level">내 단계</label>
        <select id="level">${Object.keys(LEVELS).map(k => `<option value="${k}" ${state.level === k ? 'selected' : ''}>${LEVELS[k]}</option>`).join('')}</select>
        <p class="hint">단계에 맞는 설명과 문제가 나와요. 높은 단계를 고르면 낮은 단계 내용도 함께 나와요.</p>

        <label for="llm">AI 서버 주소 (선택)</label>
        <input type="text" id="llm" placeholder="예: https://llm.example.com" value="${esc(state.llmUrl)}">
        <p class="hint">비워 두면 AI 없이 문제은행만으로 동작해요. OpenAI 호환 주소(Ollama 등)를 넣으면 '내 말로 정리하기'에서 AI 피드백을 받을 수 있어요. 비밀번호나 API 키는 여기에 넣지 마세요.</p>

        <label for="model">AI 모델 이름 (선택)</label>
        <input type="text" id="model" placeholder="예: qwen2.5:7b" value="${esc(state.llmModel)}">

        <div class="btn-row"><button class="btn ghost" id="reset">학습 기록 초기화</button><button class="btn" id="save">저장</button></div>
        <p id="msg" class="hint"></p>
      </div>`;
    document.getElementById('save').onclick = () => {
      state.level = document.getElementById('level').value;
      state.llmUrl = document.getElementById('llm').value.trim();
      state.llmModel = document.getElementById('model').value.trim();
      save();
      document.getElementById('msg').textContent = '저장했어요.';
    };
    document.getElementById('reset').onclick = () => {
      if (!confirm('학습 기록(진도, 노트, 복습)을 모두 지울까요?')) return;
      const keep = { level: state.level, llmUrl: state.llmUrl, llmModel: state.llmModel };
      state = Object.assign(defaultState(), keep);
      save();
      updateNav();
      document.getElementById('msg').textContent = '초기화했어요.';
    };
  }

  // ---------- 라우터 ----------
  async function route() {
    const parts = (location.hash.replace(/^#\/?/, '') || '').split('/');
    try {
      switch (parts[0]) {
        case 'learn': await renderLearn(decodeURIComponent(parts[1]), parseInt(parts[2] || '0', 10)); break;
        case 'quiz': await startQuiz(decodeURIComponent(parts[1])); break;
        case 'review': await startReview(); break;
        case 'notes': await renderNotes(); break;
        case 'settings': renderSettings(); break;
        default: await renderHome();
      }
    } catch (e) {
      app.innerHTML = `<div class="card"><p>데이터를 불러오지 못했어요. (${esc(e.message)})</p>
        <p class="hint">파일을 직접 열면(file://) 브라우저가 데이터를 막아요. GitHub Pages에 올리거나 로컬 서버로 열어 주세요.</p></div>`;
    }
    updateNav();
    window.scrollTo(0, 0);
  }

  window.addEventListener('hashchange', route);
  route();
})();
