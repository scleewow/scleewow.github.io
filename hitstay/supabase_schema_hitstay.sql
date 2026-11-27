-- =====================================================================
-- 힛, 스테이 (HIT, STAY) - Supabase 스키마 / 서버 로직
-- ---------------------------------------------------------------------
-- Supabase 대시보드 > SQL Editor 에 전체를 붙여 넣고 실행하세요.
-- 여러 번 실행해도 됩니다. (함수는 새로 덮어쓰고, 테이블은 있으면 그대로 둡니다)
--
-- 방 생성 인증키는 언데드 마피아의 undead_admin 테이블(createKey)을 같이 씁니다.
-- 카드(손패)와 덱은 hitstay_data.sec 에만 있고, 클라이언트는 hs_view 로
-- "공개 정보 + 내 카드"만 받습니다. (남의 카드는 볼 수 없음)
-- =====================================================================

create table if not exists public.hitstay_rooms (
    code        text primary key,
    version     bigint not null default 0,
    updated_at  timestamptz not null default now()
);

create table if not exists public.hitstay_data (
    code  text primary key references public.hitstay_rooms(code) on delete cascade,
    pub   jsonb not null default '{}'::jsonb,
    sec   jsonb not null default '{}'::jsonb
);

-- hitstay_rooms 는 방 코드와 버전만 있어 공개해도 됨 (실시간 알림용)
alter table public.hitstay_rooms enable row level security;
drop policy if exists hitstay_rooms_read on public.hitstay_rooms;
create policy hitstay_rooms_read on public.hitstay_rooms for select using (true);

-- hitstay_data 는 정책 없음 = 직접 접근 불가 (함수로만 접근)
alter table public.hitstay_data enable row level security;
revoke all on public.hitstay_data from anon, authenticated;

-- 실시간(Realtime) 발행에 방 테이블 추가
do $$
begin
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'hitstay_rooms'
    ) then
        if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
            execute 'alter publication supabase_realtime add table public.hitstay_rooms';
        end if;
    end if;
end $$;

-- =====================================================================
-- 공통 도우미
-- =====================================================================

create or replace function public.hs__now() returns bigint
language plpgsql volatile as $$
#variable_conflict use_column
begin
    return (extract(epoch from clock_timestamp()) * 1000)::bigint;
end $$;

create or replace function public.hs__err(p_code text, p_msg text) returns void
language plpgsql as $$
#variable_conflict use_column
begin
    raise exception using errcode = p_code, message = p_msg;
end $$;

create or replace function public.hs__name(p jsonb, v_pid text) returns text
language plpgsql immutable as $$
#variable_conflict use_column
begin
    return coalesce(p->'players'->v_pid->>'name', '(나간 플레이어)');
end $$;

create or replace function public.hs__n(p jsonb) returns int
language plpgsql immutable as $$
#variable_conflict use_column
begin
    return coalesce(jsonb_array_length(p->'seats'), 0);
end $$;

create or replace function public.hs__idx(p jsonb, v_pid text) returns int
language plpgsql immutable as $$
#variable_conflict use_column
declare r int;
begin
    select (o - 1)::int into r
    from jsonb_array_elements_text(p->'seats') with ordinality t(v, o)
    where v = v_pid limit 1;
    return r;
end $$;

-- p_start 자리부터 시계 방향으로 돌며 cand(배열)에 들어 있는 첫 플레이어
create or replace function public.hs__pick(p jsonb, p_start int, cand jsonb) returns text
language plpgsql immutable as $$
#variable_conflict use_column
declare n int := public.hs__n(p); i int; v text;
begin
    if n = 0 or cand is null or jsonb_array_length(cand) = 0 then return null; end if;
    for i in 0 .. n - 1 loop
        v := p->'seats'->>((((p_start + i) % n) + n) % n);
        if cand ? v then return v; end if;
    end loop;
    return null;
end $$;

create or replace function public.hs__ri(p jsonb, v_pid text, k text) returns int
language plpgsql immutable as $$
#variable_conflict use_column
begin
    return coalesce((p->'rp'->v_pid->>k)::int, 0);
end $$;

create or replace function public.hs__rb(p jsonb, v_pid text, k text) returns boolean
language plpgsql immutable as $$
#variable_conflict use_column
begin
    return coalesce((p->'rp'->v_pid->>k)::boolean, false);
end $$;

create or replace function public.hs__rset(p jsonb, v_pid text, k text, val jsonb) returns jsonb
language plpgsql immutable as $$
#variable_conflict use_column
begin
    return jsonb_set(p, array['rp', v_pid, k], val, true);
end $$;

-- 포기하지 않은 플레이어 (자리 순서)
create or replace function public.hs__live(p jsonb) returns jsonb
language plpgsql immutable as $$
#variable_conflict use_column
declare r jsonb;
begin
    select coalesce(jsonb_agg(v order by o), '[]'::jsonb) into r
    from jsonb_array_elements_text(p->'seats') with ordinality t(v, o)
    where not public.hs__rb(p, v, 'folded');
    return r;
end $$;

-- 포기·올인하지 않은 플레이어 (베팅할 수 있는 사람)
create or replace function public.hs__active(p jsonb) returns jsonb
language plpgsql immutable as $$
#variable_conflict use_column
declare r jsonb;
begin
    select coalesce(jsonb_agg(v order by o), '[]'::jsonb) into r
    from jsonb_array_elements_text(p->'seats') with ordinality t(v, o)
    where not public.hs__rb(p, v, 'folded') and not public.hs__rb(p, v, 'allin');
    return r;
end $$;

-- 힛/스테이를 아직 할 수 있는 사람 (포기·스테이하지 않은 사람)
create or replace function public.hs__hitters(p jsonb) returns jsonb
language plpgsql immutable as $$
#variable_conflict use_column
declare r jsonb;
begin
    select coalesce(jsonb_agg(v order by o), '[]'::jsonb) into r
    from jsonb_array_elements_text(p->'seats') with ordinality t(v, o)
    where not public.hs__rb(p, v, 'folded') and not public.hs__rb(p, v, 'stayed');
    return r;
end $$;

create or replace function public.hs__curmax(p jsonb) returns int
language plpgsql immutable as $$
#variable_conflict use_column
declare r int;
begin
    select coalesce(max(public.hs__ri(p, v, 'contrib')), 0) into r
    from jsonb_array_elements_text(p->'seats') t(v);
    return r;
end $$;

-- 이번 라운드에 v_pid 가 베팅(총액 기준)을 올릴 수 있는 최대 금액
--  원작 룰: 포기하지 않은 사람 중 (이번 라운드 낸 칩 + 남은 칩)이 가장 적은 사람 기준
--  포커 룰: 내 칩 전부, 단 상대 중 가장 많이 따라올 수 있는 사람까지만
create or replace function public.hs__maxlevel(p jsonb, v_pid text) returns int
language plpgsql immutable as $$
#variable_conflict use_column
declare
    side boolean := coalesce((p->'settings'->>'sidePot')::int, 0) = 1;
    mine int := public.hs__ri(p, v_pid, 'contrib') + coalesce((p->'chips'->>v_pid)::int, 0);
    r int;
begin
    if side then
        select max(public.hs__ri(p, v, 'contrib') + coalesce((p->'chips'->>v)::int, 0)) into r
        from jsonb_array_elements_text(p->'seats') t(v)
        where v <> v_pid and not public.hs__rb(p, v, 'folded');
        return least(mine, coalesce(r, 0));
    else
        select min(public.hs__ri(p, v, 'contrib') + coalesce((p->'chips'->>v)::int, 0)) into r
        from jsonb_array_elements_text(p->'seats') t(v)
        where not public.hs__rb(p, v, 'folded');
        return least(mine, coalesce(r, 0));
    end if;
end $$;

create or replace function public.hs__deadline(p jsonb) returns jsonb
language plpgsql volatile as $$
#variable_conflict use_column
declare sec int := coalesce((p->'settings'->>'turnSec')::int, 0);
begin
    if sec > 0 then return to_jsonb(public.hs__now() + sec * 1000); end if;
    return 'null'::jsonb;
end $$;

create or replace function public.hs__set_turn(p jsonb, v_pid text) returns jsonb
language plpgsql volatile as $$
#variable_conflict use_column
begin
    p := jsonb_set(p, '{turn}', coalesce(to_jsonb(v_pid), 'null'::jsonb));
    if v_pid is null then
        p := jsonb_set(p, '{deadline}', 'null'::jsonb);
    else
        p := jsonb_set(p, '{deadline}', public.hs__deadline(p));
    end if;
    return p;
end $$;

create or replace function public.hs__log(p jsonb, msg text) returns jsonb
language plpgsql immutable as $$
#variable_conflict use_column
begin
    return jsonb_set(p, '{log}', coalesce(p->'log', '[]'::jsonb) || to_jsonb(msg));
end $$;

-- =====================================================================
-- 진행 단계
-- =====================================================================

-- 베팅 시작 (BET1 / BET2)
create or replace function public.hs__begin_bet(p jsonb, v_phase text) returns jsonb
language plpgsql volatile as $$
#variable_conflict use_column
declare
    act jsonb := public.hs__active(p);
    cur int := public.hs__curmax(p);
    v text;
begin
    p := jsonb_set(p, '{phase}', to_jsonb(v_phase));
    -- 베팅할 수 있는 사람이 1명뿐이고 이미 최고액을 냈다면 베팅할 필요 없음
    if jsonb_array_length(act) = 1 and public.hs__ri(p, act->>0, 'contrib') >= cur then
        act := '[]'::jsonb;
    end if;
    -- 베팅 행동 표시 초기화
    for v in select jsonb_array_elements_text(act) loop
        p := public.hs__rset(p, v, 'act', 'null'::jsonb);
    end loop;
    p := jsonb_set(p, '{toAct}', act);
    p := public.hs__log(p, case when v_phase = 'BET1' then '― 1차 베팅 ―' else '― 2차 베팅 ―' end);
    p := public.hs__set_turn(p, public.hs__pick(p, (p->>'dealerIdx')::int, act));
    return p;
end $$;

create or replace function public.hs__begin_hit(p jsonb) returns jsonb
language plpgsql volatile as $$
#variable_conflict use_column
begin
    p := jsonb_set(p, '{phase}', '"HIT"');
    p := public.hs__log(p, '― 힛 / 스테이 ―');
    p := public.hs__set_turn(p, public.hs__pick(p, (p->>'dealerIdx')::int, public.hs__hitters(p)));
    return p;
end $$;

-- 라운드 시작: 기본 베팅, 한계 숫자, 카드 3장 지급
create or replace function public.hs__start_round(inout p jsonb, inout s jsonb)
language plpgsql volatile as $$
#variable_conflict use_column
declare
    n int := public.hs__n(p);
    rnd int := coalesce((p->>'round')::int, 0) + 1;
    base int := 1 + (rnd - 1) / 10;
    dealer int;
    lim int := 5 + floor(random() * 8)::int;
    deck jsonb;
    hands jsonb := '{}'::jsonb;
    rp jsonb := '{}'::jsonb;
    chips jsonb := p->'chips';
    i int; v text; have int; pay int;
begin
    if rnd = 1 then dealer := floor(random() * n)::int;
    else dealer := (((p->>'dealerIdx')::int + 1) % n);
    end if;

    select jsonb_agg(c order by random()) into deck
    from unnest(array[7,6,6,5,5,5,4,4,4,4,3,3,3,3,3,2,2,2,2,2,2,1,1,1,1,1,1,1,-1,-1,-1,-1,-1,-1,-1]) c;

    for i in 0 .. n - 1 loop
        v := p->'seats'->>((dealer + i) % n);
        have := coalesce((chips->>v)::int, 0);
        pay := least(base, have);
        chips := jsonb_set(chips, array[v], to_jsonb(have - pay));
        rp := rp || jsonb_build_object(v, jsonb_build_object(
            'contrib', pay, 'folded', false, 'allin', (have - pay) = 0, 'stayed', false,
            'opened', false, 'open', '[]'::jsonb, 'cnt', 3, 'act', null));
        hands := hands || jsonb_build_object(v, jsonb_build_array(deck->0, deck->1, deck->2));
        deck := deck - 0 - 0 - 0;
    end loop;

    p := p || jsonb_build_object(
        'round', rnd, 'baseBet', base, 'dealerIdx', dealer, 'limit', lim,
        'chips', chips, 'rp', rp, 'phase', 'OPEN', 'toAct', '[]'::jsonb,
        'deckLeft', jsonb_array_length(deck), 'result', null,
        'roundStartAt', public.hs__now(),
        'log', jsonb_build_array(format('라운드 %s · 한계 숫자 %s · 기본 베팅 %s개', rnd, lim, base)));
    p := jsonb_set(p, '{turn}', 'null'::jsonb);
    p := jsonb_set(p, '{deadline}', public.hs__deadline(p));
    s := s || jsonb_build_object('deck', deck, 'hands', hands, 'openPick', '{}'::jsonb);
end $$;

-- 정산 (승부 또는 모두 포기)
create or replace function public.hs__resolve(inout p jsonb, inout s jsonb, by_fold boolean)
language plpgsql volatile as $$
#variable_conflict use_column
declare
    n int := public.hs__n(p);
    dealer int := (p->>'dealerIdx')::int;
    lim int := (p->>'limit')::int;
    live jsonb := public.hs__live(p);
    info jsonb := '{}'::jsonb;
    hands jsonb := '{}'::jsonb;
    pots jsonb := '[]'::jsonb;
    gains jsonb := '{}'::jsonb;
    contribs jsonb := '{}'::jsonb;
    chips jsonb := p->'chips';
    lvls int[]; lvl int; prev int := 0; k int;
    amt int; elig jsonb; win jsonb; any_ok boolean; bs int; bc int;
    nw int; share int; rem int; v text; w text; c int; sm int; cn int; bust boolean;
    kind text; lines jsonb := '[]'::jsonb; got int;
begin
    -- 손패 정보
    for v in select jsonb_array_elements_text(live) loop
        select coalesce(sum(x::int), 0), count(*) into sm, cn from jsonb_array_elements_text(s->'hands'->v) x;
        bust := sm > lim;
        info := info || jsonb_build_object(v, jsonb_build_object('sum', sm, 'cnt', cn, 'bust', bust));
        if not by_fold then
            hands := hands || jsonb_build_object(v, jsonb_build_object('cards', s->'hands'->v, 'sum', sm, 'cnt', cn, 'bust', bust));
        end if;
    end loop;

    for v in select jsonb_array_elements_text(p->'seats') loop
        contribs := contribs || jsonb_build_object(v, public.hs__ri(p, v, 'contrib'));
        gains := gains || jsonb_build_object(v, 0);
    end loop;

    -- 팟 나누기: 포기하지 않은 사람들의 베팅 금액 단계별로
    select array_agg(distinct public.hs__ri(p, v, 'contrib') order by public.hs__ri(p, v, 'contrib'))
      into lvls from jsonb_array_elements_text(live) t(v);

    for k in 1 .. coalesce(array_length(lvls, 1), 0) loop
        lvl := lvls[k];
        select coalesce(sum(least(public.hs__ri(p, v, 'contrib'), lvl) - least(public.hs__ri(p, v, 'contrib'), prev)), 0)
          into amt from jsonb_array_elements_text(p->'seats') t(v);
        if k = array_length(lvls, 1) then
            -- 포기한 사람이 더 많이 낸 칩은 마지막 팟에 포함
            select amt + coalesce(sum(greatest(public.hs__ri(p, v, 'contrib') - lvl, 0)), 0)
              into amt from jsonb_array_elements_text(p->'seats') t(v);
        end if;
        select coalesce(jsonb_agg(v order by o), '[]'::jsonb) into elig
          from jsonb_array_elements_text(live) with ordinality t(v, o)
          where public.hs__ri(p, v, 'contrib') >= lvl;
        prev := lvl;
        continue when amt <= 0 or jsonb_array_length(elig) = 0;

        -- 승자 결정
        any_ok := false; bs := null; bc := null; win := '[]'::jsonb;
        for v in select jsonb_array_elements_text(elig) loop
            if not (info->v->>'bust')::boolean then any_ok := true; end if;
        end loop;
        if not any_ok then
            win := elig;   -- 모두 한계 초과 → 무승부
        else
            for v in select jsonb_array_elements_text(elig) loop
                continue when (info->v->>'bust')::boolean;
                sm := (info->v->>'sum')::int; cn := (info->v->>'cnt')::int;
                if bs is null or sm > bs or (sm = bs and cn > bc) then
                    win := jsonb_build_array(v); bs := sm; bc := cn;
                elsif sm = bs and cn = bc then
                    win := win || to_jsonb(v);
                end if;
            end loop;
        end if;

        -- 선 플레이어에 가까운 순서로 정렬
        select jsonb_agg(v order by (((public.hs__idx(p, v) - dealer) % n) + n) % n) into win
          from jsonb_array_elements_text(win) t(v);

        nw := jsonb_array_length(win);
        share := amt / nw; rem := amt % nw;
        for v in select jsonb_array_elements_text(win) loop
            got := share + case when rem > 0 then 1 else 0 end;
            if rem > 0 then rem := rem - 1; end if;
            gains := jsonb_set(gains, array[v], to_jsonb((gains->>v)::int + got));
        end loop;

        kind := case
            when jsonb_array_length(elig) = 1 and not by_fold then 'return'
            when by_fold then 'fold'
            when not any_ok then 'allbust'
            when nw > 1 then 'tie'
            else 'win' end;
        pots := pots || jsonb_build_object('amount', amt, 'elig', elig, 'winners', win, 'kind', kind);
    end loop;

    -- 칩 반영
    for v in select jsonb_array_elements_text(p->'seats') loop
        chips := jsonb_set(chips, array[v], to_jsonb(coalesce((chips->>v)::int, 0) + (gains->>v)::int));
        got := (gains->>v)::int - public.hs__ri(p, v, 'contrib');
        if got <> 0 then
            lines := lines || to_jsonb(format('%s %s%s', public.hs__name(p, v), case when got > 0 then '+' else '' end, got));
        end if;
    end loop;

    p := p || jsonb_build_object(
        'chips', chips, 'phase', 'SHOW', 'toAct', '[]'::jsonb,
        'result', jsonb_build_object('byFold', by_fold, 'hands', hands, 'pots', pots, 'gains', gains, 'contrib', contribs));
    p := jsonb_set(p, '{turn}', 'null'::jsonb);
    p := jsonb_set(p, '{deadline}', to_jsonb(public.hs__now() + case when by_fold then 8000 else 15000 end));

    p := jsonb_set(p, '{history}', (
        select coalesce(jsonb_agg(h), '[]'::jsonb) from (
            select h from jsonb_array_elements(coalesce(p->'history', '[]'::jsonb)) h
            offset greatest(jsonb_array_length(coalesce(p->'history', '[]'::jsonb)) - 59, 0)
        ) z
    ) || jsonb_build_array(jsonb_build_object(
        'round', p->'round', 'limit', p->'limit', 'byFold', by_fold,
        'log', p->'log', 'hands', hands, 'pots', pots, 'lines', lines)));
end $$;

-- 자동 진행 (단계가 끝났는지 확인하고 다음 단계로)
create or replace function public.hs__advance(inout p jsonb, inout s jsonb)
language plpgsql volatile as $$
#variable_conflict use_column
declare ph text; v text; guard int := 0;
begin
    loop
        guard := guard + 1;
        exit when guard > 20 or p->>'state' <> 'PLAY';
        ph := p->>'phase';
        if ph in ('BET1', 'BET2') then
            if jsonb_array_length(public.hs__live(p)) <= 1 then
                select * into p, s from public.hs__resolve(p, s, true);
                exit;
            end if;
            if jsonb_array_length(p->'toAct') = 0 then
                if ph = 'BET1' then p := public.hs__begin_hit(p);
                else
                    select * into p, s from public.hs__resolve(p, s, false);
                    exit;
                end if;
            else
                exit;
            end if;
        elsif ph = 'HIT' then
            if coalesce((p->>'deckLeft')::int, 0) <= 0 or jsonb_array_length(public.hs__hitters(p)) = 0 then
                if coalesce((p->>'deckLeft')::int, 0) <= 0 then p := public.hs__log(p, '추가 카드가 모두 소진되었습니다.'); end if;
                p := public.hs__begin_bet(p, 'BET2');
            else
                exit;
            end if;
        elsif ph = 'OPEN' then
            if exists (select 1 from jsonb_array_elements_text(p->'seats') t(v) where not public.hs__rb(p, v, 'opened')) then
                exit;
            end if;
            -- 모두 골랐으면 한꺼번에 공개
            for v in select jsonb_array_elements_text(p->'seats') loop
                p := public.hs__rset(p, v, 'open', jsonb_build_array(s->'hands'->v->(s->'openPick'->>v)::int));
                p := public.hs__rset(p, v, 'openIdx', s->'openPick'->v);
            end loop;
            p := public.hs__begin_bet(p, 'BET1');
        else
            exit;
        end if;
    end loop;
end $$;

-- 행동: 카드 공개 선택
create or replace function public.hs__do_open(inout p jsonb, inout s jsonb, v_pid text, v_idx int)
language plpgsql volatile as $$
#variable_conflict use_column
begin
    if public.hs__rb(p, v_pid, 'opened') then perform public.hs__err('UD001', '이미 공개할 카드를 골랐습니다.'); end if;
    if v_idx is null or v_idx < 0 or v_idx > 2 then perform public.hs__err('UD001', '공개할 카드를 골라 주세요.'); end if;
    s := jsonb_set(s, array['openPick', v_pid], to_jsonb(v_idx));
    p := public.hs__rset(p, v_pid, 'opened', 'true');
end $$;

-- 행동: 콜 / 레이즈 / 포기
create or replace function public.hs__do_bet(p jsonb, v_pid text, v_act text, v_amt int) returns jsonb
language plpgsql volatile as $$
#variable_conflict use_column
declare
    cur int := public.hs__curmax(p);
    c int := public.hs__ri(p, v_pid, 'contrib');
    st int := coalesce((p->'chips'->>v_pid)::int, 0);
    need int; pay int; lvl int; maxl int; lbl text; others int;
begin
    if v_act = 'fold' then
        p := public.hs__rset(p, v_pid, 'folded', 'true');
        lbl := '포기';
    elsif v_act = 'call' then
        need := greatest(cur - c, 0);
        pay := least(need, st);
        c := c + pay; st := st - pay;
        lbl := case when need = 0 then '체크' when st = 0 then format('올인 (%s개)', pay) else format('콜 (%s개)', pay) end;
    elsif v_act = 'raise' then
        if v_amt is null or v_amt < 1 then perform public.hs__err('UD001', '레이즈는 1개 이상이어야 합니다.'); end if;
        select count(*) into others from jsonb_array_elements_text(public.hs__active(p)) t(v) where v <> v_pid;
        if others = 0 then perform public.hs__err('UD001', '레이즈를 받을 상대가 없습니다. 콜 또는 포기만 할 수 있습니다.'); end if;
        maxl := public.hs__maxlevel(p, v_pid);
        if cur + v_amt > maxl then
            perform public.hs__err('UD001', format('지금은 최대 %s개까지 레이즈할 수 있습니다.', greatest(maxl - cur, 0)));
        end if;
        lvl := cur + v_amt; pay := lvl - c;
        c := lvl; st := st - pay;
        lbl := case when st = 0 then format('올인 레이즈 +%s', v_amt) else format('레이즈 +%s', v_amt) end;
    else
        perform public.hs__err('UD001', '알 수 없는 행동입니다.');
    end if;

    p := public.hs__rset(p, v_pid, 'contrib', to_jsonb(c));
    p := jsonb_set(p, array['chips', v_pid], to_jsonb(st));
    if st = 0 and v_act <> 'fold' then p := public.hs__rset(p, v_pid, 'allin', 'true'); end if;
    p := public.hs__rset(p, v_pid, 'act', to_jsonb(lbl));
    p := public.hs__log(p, public.hs__name(p, v_pid) || ' ' || lbl);

    if v_act = 'raise' then
        p := jsonb_set(p, '{toAct}', public.hs__active(p) - v_pid);
    else
        p := jsonb_set(p, '{toAct}', coalesce(p->'toAct', '[]'::jsonb) - v_pid);
    end if;
    p := public.hs__set_turn(p, public.hs__pick(p, public.hs__idx(p, v_pid) + 1, p->'toAct'));
    return p;
end $$;

-- 행동: 힛 / 스테이
create or replace function public.hs__do_hit(inout p jsonb, inout s jsonb, v_pid text, v_act text)
language plpgsql volatile as $$
#variable_conflict use_column
declare card jsonb;
begin
    if v_act = 'hit' then
        if coalesce((p->>'deckLeft')::int, 0) <= 0 then perform public.hs__err('UD001', '남은 카드가 없습니다.'); end if;
        card := s->'deck'->0;
        s := jsonb_set(s, '{deck}', (s->'deck') - 0);
        s := jsonb_set(s, array['hands', v_pid], (s->'hands'->v_pid) || jsonb_build_array(card));
        p := public.hs__rset(p, v_pid, 'open', (p->'rp'->v_pid->'open') || jsonb_build_array(card));
        p := public.hs__rset(p, v_pid, 'cnt', to_jsonb(public.hs__ri(p, v_pid, 'cnt') + 1));
        p := jsonb_set(p, '{deckLeft}', to_jsonb(jsonb_array_length(s->'deck')));
        p := public.hs__rset(p, v_pid, 'act', '"힛"');
        p := public.hs__log(p, format('%s 힛 → %s', public.hs__name(p, v_pid), card));
    elsif v_act = 'stay' then
        p := public.hs__rset(p, v_pid, 'stayed', 'true');
        p := public.hs__rset(p, v_pid, 'act', '"스테이"');
        p := public.hs__log(p, public.hs__name(p, v_pid) || ' 스테이');
    else
        perform public.hs__err('UD001', '알 수 없는 행동입니다.');
    end if;
    p := public.hs__set_turn(p, public.hs__pick(p, public.hs__idx(p, v_pid) + 1, public.hs__hitters(p)));
end $$;

-- 라운드 결과 화면이 끝난 뒤: 게임 종료 확인 또는 다음 라운드
create or replace function public.hs__after_show(inout p jsonb, inout s jsonb)
language plpgsql volatile as $$
#variable_conflict use_column
declare
    maxr int := coalesce((p->'settings'->>'maxRounds')::int, 0);
    busted boolean;
    rk jsonb;
begin
    select exists (select 1 from jsonb_array_elements_text(p->'seats') t(v) where coalesce((p->'chips'->>v)::int, 0) <= 0)
      into busted;
    if busted or (maxr > 0 and (p->>'round')::int >= maxr) then
        select jsonb_agg(jsonb_build_object('pid', v, 'name', public.hs__name(p, v), 'chips', ch, 'rank', rk2) order by rk2, o)
          into rk
          from (
            select v, o, coalesce((p->'chips'->>v)::int, 0) ch,
                   rank() over (order by coalesce((p->'chips'->>v)::int, 0) desc) rk2
            from jsonb_array_elements_text(p->'seats') with ordinality t(v, o)
          ) z;
        p := p || jsonb_build_object('state', 'ENDED', 'ranking', rk,
            'endReason', case when busted then 'bust' else 'rounds' end, 'deadline', null, 'turn', null);
    else
        select * into p, s from public.hs__start_round(p, s);
        select * into p, s from public.hs__advance(p, s);
    end if;
end $$;

-- =====================================================================
-- 방 로드 / 저장 / 인증
-- =====================================================================

create or replace function public.hs__save(p_code text, p jsonb, s jsonb) returns void
language plpgsql volatile as $$
#variable_conflict use_column
begin
    update public.hitstay_data set pub = p, sec = s where code = p_code;
    update public.hitstay_rooms set version = version + 1, updated_at = now() where code = p_code;
end $$;

create or replace function public.hs__auth(p jsonb, s jsonb, p_pid text, p_key text) returns void
language plpgsql immutable as $$
#variable_conflict use_column
begin
    if p_pid is null or p_key is null or (s->'keys'->>p_pid) is distinct from p_key or not (p->'players' ? p_pid) then
        perform public.hs__err('UD002', '인증 실패');
    end if;
end $$;

create or replace function public.hs__host(p jsonb, p_pid text) returns void
language plpgsql immutable as $$
#variable_conflict use_column
begin
    if (p->>'hostId') is distinct from p_pid then perform public.hs__err('UD003', '방장만 할 수 있습니다.'); end if;
end $$;

-- =====================================================================
-- 공개 함수 (클라이언트에서 호출)
-- =====================================================================

create or replace function public.hs_view(p_code text, p_pid text, p_key text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
#variable_conflict use_column
declare ver bigint; p jsonb; s jsonb; me jsonb := null;
begin
    select r.version, d.pub, d.sec into ver, p, s
      from public.hitstay_rooms r join public.hitstay_data d on d.code = r.code
     where r.code = upper(p_code);
    if not found then return null; end if;
    if p_pid is not null and p_key is not null and (s->'keys'->>p_pid) = p_key and (p->'players' ? p_pid) then
        me := jsonb_build_object('pid', p_pid,
            'hand', coalesce(s->'hands'->p_pid, '[]'::jsonb),
            'openPick', s->'openPick'->p_pid);
    end if;
    return jsonb_build_object('version', ver, 'now', public.hs__now(), 'pub', p, 'me', me);
end $$;

create or replace function public.hs_create(p_code text, p_create_hash text, p_pid text, p_key text, p_name text) returns boolean
language plpgsql volatile security definer set search_path = public as $$
#variable_conflict use_column
declare
    r record; e record; found_cfg boolean := false; ok boolean := false;
    p jsonb; s jsonb; v_code text := upper(p_code);
begin
    -- 방 생성 인증키 확인 (undead_admin 테이블의 createKey 행)
    begin
        for r in execute 'select to_jsonb(t) as j from public.undead_admin t' loop
            if exists (select 1 from jsonb_each_text(r.j) x where x.value = 'createKey') then
                found_cfg := true;
                for e in select x.key, x.value from jsonb_each_text(r.j) x loop
                    continue when e.value is null or e.value = 'createKey';
                    if lower(e.value) = lower(p_create_hash)
                       or encode(sha256(convert_to(e.value, 'UTF8')), 'hex') = lower(p_create_hash) then
                        ok := true;
                    end if;
                end loop;
            end if;
        end loop;
    exception when undefined_table then
        found_cfg := false;
    end;
    if not found_cfg then perform public.hs__err('UD004', 'createKey 설정 없음'); end if;
    if not ok then perform public.hs__err('UD005', '방 생성 키가 올바르지 않습니다.'); end if;

    if coalesce(trim(p_name), '') = '' then perform public.hs__err('UD001', '닉네임을 입력해 주세요.'); end if;

    -- 오래된 방 정리
    delete from public.hitstay_rooms where updated_at < now() - interval '1 day';

    if exists (select 1 from public.hitstay_rooms where code = v_code) then return false; end if;

    p := jsonb_build_object(
        'state', 'LOBBY', 'hostId', p_pid,
        'players', jsonb_build_object(p_pid, jsonb_build_object('name', left(trim(p_name), 20), 'isHost', true)),
        'settings', jsonb_build_object('startChips', 30, 'turnSec', 30, 'maxRounds', 20, 'sidePot', 0));
    s := jsonb_build_object('keys', jsonb_build_object(p_pid, p_key));

    insert into public.hitstay_rooms(code) values (v_code);
    insert into public.hitstay_data(code, pub, sec) values (v_code, p, s);
    return true;
end $$;

create or replace function public.hs_join(p_code text, p_pid text, p_key text, p_name text) returns boolean
language plpgsql volatile security definer set search_path = public as $$
#variable_conflict use_column
declare p jsonb; s jsonb; v_code text := upper(p_code); nm text := left(trim(coalesce(p_name, '')), 20);
begin
    select pub, sec into p, s from public.hitstay_data where code = v_code for update;
    if not found then perform public.hs__err('P0002', '방이 없습니다.'); end if;
    if nm = '' then perform public.hs__err('UD001', '닉네임을 입력해 주세요.'); end if;
    if p->'players' ? p_pid then
        if (s->'keys'->>p_pid) is distinct from p_key then perform public.hs__err('UD002', '인증 실패'); end if;
        if (p->'players'->p_pid->>'name') = nm then return true; end if;
        p := jsonb_set(p, array['players', p_pid, 'name'], to_jsonb(nm));
    else
        if (select count(*) from jsonb_object_keys(p->'players')) >= 12 then
            perform public.hs__err('UD001', '방이 가득 찼습니다.');
        end if;
        p := jsonb_set(p, array['players', p_pid], jsonb_build_object('name', nm, 'isHost', false));
        s := jsonb_set(s, array['keys', p_pid], to_jsonb(p_key));
    end if;
    perform public.hs__save(v_code, p, s);
    return true;
end $$;

create or replace function public.hs_set_option(p_code text, p_pid text, p_key text, p_opt text, p_val int) returns boolean
language plpgsql volatile security definer set search_path = public as $$
#variable_conflict use_column
declare p jsonb; s jsonb; v_code text := upper(p_code);
begin
    select pub, sec into p, s from public.hitstay_data where code = v_code for update;
    if not found then perform public.hs__err('P0002', '방이 없습니다.'); end if;
    perform public.hs__auth(p, s, p_pid, p_key);
    perform public.hs__host(p, p_pid);
    if p->>'state' <> 'LOBBY' then perform public.hs__err('UD001', '대기실에서만 바꿀 수 있습니다.'); end if;
    if p_opt = 'startChips' and p_val between 5 and 500 then null;
    elsif p_opt = 'turnSec' and p_val between 0 and 600 then null;
    elsif p_opt = 'maxRounds' and p_val between 0 and 200 then null;
    elsif p_opt = 'sidePot' and p_val in (0, 1) then null;
    else perform public.hs__err('UD001', '설정 값이 올바르지 않습니다.');
    end if;
    p := jsonb_set(p, array['settings', p_opt], to_jsonb(p_val));
    perform public.hs__save(v_code, p, s);
    return true;
end $$;

create or replace function public.hs_kick(p_code text, p_pid text, p_key text, p_target text) returns boolean
language plpgsql volatile security definer set search_path = public as $$
#variable_conflict use_column
declare p jsonb; s jsonb; v_code text := upper(p_code);
begin
    select pub, sec into p, s from public.hitstay_data where code = v_code for update;
    if not found then perform public.hs__err('P0002', '방이 없습니다.'); end if;
    perform public.hs__auth(p, s, p_pid, p_key);
    perform public.hs__host(p, p_pid);
    if p_target = p_pid then perform public.hs__err('UD001', '방장은 강퇴할 수 없습니다.'); end if;
    if p->>'state' <> 'LOBBY' and coalesce(p->'seats', '[]'::jsonb) ? p_target then
        perform public.hs__err('UD001', '게임에 참여 중인 플레이어는 게임 중에 강퇴할 수 없습니다. 강제 재시작 후 대기실에서 강퇴해 주세요.');
    end if;
    p := jsonb_set(p, '{players}', (p->'players') - p_target);
    s := jsonb_set(s, '{keys}', (s->'keys') - p_target);
    perform public.hs__save(v_code, p, s);
    return true;
end $$;

create or replace function public.hs_start(p_code text, p_pid text, p_key text) returns boolean
language plpgsql volatile security definer set search_path = public as $$
#variable_conflict use_column
declare p jsonb; s jsonb; v_code text := upper(p_code); n int; seats jsonb; chips jsonb := '{}'::jsonb; v text;
begin
    select pub, sec into p, s from public.hitstay_data where code = v_code for update;
    if not found then perform public.hs__err('P0002', '방이 없습니다.'); end if;
    perform public.hs__auth(p, s, p_pid, p_key);
    perform public.hs__host(p, p_pid);
    if p->>'state' <> 'LOBBY' then perform public.hs__err('UD001', '이미 게임이 진행 중입니다.'); end if;
    select count(*) into n from jsonb_object_keys(p->'players');
    if n < 2 or n > 7 then perform public.hs__err('UD001', '2~7명일 때 시작할 수 있습니다.'); end if;

    select jsonb_agg(k order by random()) into seats from jsonb_object_keys(p->'players') k;
    for v in select jsonb_array_elements_text(seats) loop
        chips := chips || jsonb_build_object(v, coalesce((p->'settings'->>'startChips')::int, 30));
    end loop;
    p := p || jsonb_build_object('state', 'PLAY', 'seats', seats, 'chips', chips, 'round', 0,
                                 'history', '[]'::jsonb, 'ranking', null, 'endReason', null);
    s := jsonb_build_object('keys', s->'keys');
    select * into p, s from public.hs__start_round(p, s);
    select * into p, s from public.hs__advance(p, s);
    perform public.hs__save(v_code, p, s);
    return true;
end $$;

create or replace function public.hs_act(p_code text, p_pid text, p_key text, p_act text, p_val int) returns boolean
language plpgsql volatile security definer set search_path = public as $$
#variable_conflict use_column
declare p jsonb; s jsonb; v_code text := upper(p_code); ph text;
begin
    select pub, sec into p, s from public.hitstay_data where code = v_code for update;
    if not found then perform public.hs__err('P0002', '방이 없습니다.'); end if;
    perform public.hs__auth(p, s, p_pid, p_key);
    if p->>'state' <> 'PLAY' then perform public.hs__err('UD001', '게임 중이 아닙니다.'); end if;
    if not (coalesce(p->'seats', '[]'::jsonb) ? p_pid) then perform public.hs__err('UD001', '이번 게임 참가자가 아닙니다.'); end if;
    ph := p->>'phase';

    if p_act = 'open' then
        if ph <> 'OPEN' then perform public.hs__err('UD001', '지금은 카드를 공개하는 단계가 아닙니다.'); end if;
        select * into p, s from public.hs__do_open(p, s, p_pid, p_val);
    elsif p_act in ('call', 'raise', 'fold') then
        if ph not in ('BET1', 'BET2') then perform public.hs__err('UD001', '지금은 베팅 단계가 아닙니다.'); end if;
        if (p->>'turn') is distinct from p_pid then perform public.hs__err('UD001', '내 차례가 아닙니다.'); end if;
        p := public.hs__do_bet(p, p_pid, p_act, p_val);
    elsif p_act in ('hit', 'stay') then
        if ph <> 'HIT' then perform public.hs__err('UD001', '지금은 힛/스테이 단계가 아닙니다.'); end if;
        if (p->>'turn') is distinct from p_pid then perform public.hs__err('UD001', '내 차례가 아닙니다.'); end if;
        select * into p, s from public.hs__do_hit(p, s, p_pid, p_act);
    else
        perform public.hs__err('UD001', '알 수 없는 행동입니다.');
    end if;

    select * into p, s from public.hs__advance(p, s);
    perform public.hs__save(v_code, p, s);
    return true;
end $$;

-- 시간 초과 처리 (누구나 호출 가능, 서버가 실제 시간을 확인) / 강제 진행 (방장)
create or replace function public.hs_tick(p_code text, p_pid text, p_key text, p_force boolean) returns boolean
language plpgsql volatile security definer set search_path = public as $$
#variable_conflict use_column
declare p jsonb; s jsonb; v_code text := upper(p_code); ph text; dl bigint; v text; t text;
begin
    select pub, sec into p, s from public.hitstay_data where code = v_code for update;
    if not found then perform public.hs__err('P0002', '방이 없습니다.'); end if;
    perform public.hs__auth(p, s, p_pid, p_key);
    if p_force then perform public.hs__host(p, p_pid); end if;
    if p->>'state' <> 'PLAY' then return false; end if;

    ph := p->>'phase';
    dl := nullif(p->>'deadline', '')::bigint;
    if not p_force and (dl is null or public.hs__now() < dl) then return false; end if;

    if ph = 'SHOW' then
        select * into p, s from public.hs__after_show(p, s);
    elsif ph = 'OPEN' then
        for v in select jsonb_array_elements_text(p->'seats') loop
            if not public.hs__rb(p, v, 'opened') then
                select * into p, s from public.hs__do_open(p, s, v, floor(random() * 3)::int);
                p := public.hs__log(p, public.hs__name(p, v) || ' 시간 초과 → 공개 카드 자동 선택');
            end if;
        end loop;
        select * into p, s from public.hs__advance(p, s);
    elsif ph in ('BET1', 'BET2') then
        t := p->>'turn';
        if t is not null then
            p := public.hs__log(p, public.hs__name(p, t) || ' 시간 초과 → 자동 콜');
            p := public.hs__do_bet(p, t, 'call', null);
        end if;
        select * into p, s from public.hs__advance(p, s);
    elsif ph = 'HIT' then
        t := p->>'turn';
        if t is not null then
            p := public.hs__log(p, public.hs__name(p, t) || ' 시간 초과 → 자동 스테이');
            select * into p, s from public.hs__do_hit(p, s, t, 'stay');
        end if;
        select * into p, s from public.hs__advance(p, s);
    end if;

    perform public.hs__save(v_code, p, s);
    return true;
end $$;

create or replace function public.hs_restart(p_code text, p_pid text, p_key text) returns boolean
language plpgsql volatile security definer set search_path = public as $$
#variable_conflict use_column
declare p jsonb; s jsonb; v_code text := upper(p_code);
begin
    select pub, sec into p, s from public.hitstay_data where code = v_code for update;
    if not found then perform public.hs__err('P0002', '방이 없습니다.'); end if;
    perform public.hs__auth(p, s, p_pid, p_key);
    perform public.hs__host(p, p_pid);
    p := (p - 'seats' - 'chips' - 'rp' - 'round' - 'baseBet' - 'dealerIdx' - 'limit' - 'phase' - 'turn'
           - 'deadline' - 'toAct' - 'deckLeft' - 'result' - 'log' - 'history' - 'ranking' - 'endReason' - 'roundStartAt')
         || jsonb_build_object('state', 'LOBBY');
    s := jsonb_build_object('keys', s->'keys');
    perform public.hs__save(v_code, p, s);
    return true;
end $$;

create or replace function public.hs_delete(p_code text, p_pid text, p_key text) returns boolean
language plpgsql volatile security definer set search_path = public as $$
#variable_conflict use_column
declare p jsonb; s jsonb; v_code text := upper(p_code);
begin
    select pub, sec into p, s from public.hitstay_data where code = v_code for update;
    if not found then return true; end if;
    perform public.hs__auth(p, s, p_pid, p_key);
    perform public.hs__host(p, p_pid);
    delete from public.hitstay_rooms where code = v_code;
    return true;
end $$;

-- 실행 권한: 힛스테이 내부 도우미(hs__*)는 직접 호출 금지, 공개 함수(hs_*)만 허용
-- (다른 게임의 함수 권한은 건드리지 않습니다)
do $$
declare f text;
begin
    for f in
        select format('%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'hs\_\_%'
    loop
        execute format('revoke all on function public.%s from public', f);
        begin
            execute format('revoke all on function public.%s from anon, authenticated', f);
        exception when undefined_object then null;
        end;
    end loop;
    foreach f in array array[
        'hs_view(text,text,text)',
        'hs_create(text,text,text,text,text)',
        'hs_join(text,text,text,text)',
        'hs_set_option(text,text,text,text,int)',
        'hs_kick(text,text,text,text)',
        'hs_start(text,text,text)',
        'hs_act(text,text,text,text,int)',
        'hs_tick(text,text,text,boolean)',
        'hs_restart(text,text,text)',
        'hs_delete(text,text,text)'
    ] loop
        begin
            execute format('grant execute on function public.%s to anon, authenticated', f);
        exception when undefined_object then null;
        end;
    end loop;
end $$;
