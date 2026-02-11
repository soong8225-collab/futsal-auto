from __future__ import annotations

from typing import List, Optional, Dict, Any, Tuple
import random
import math

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


# =========================
# Settings (요청 반영)
# =========================
LINE_LIMIT = 10          # 라인(1번vs1번...) 허용 차이
GK_TOLERANCE = 7         # GK 매칭 ±7
SWAP_ITERS = 900         # 스왑 탐색 횟수

W_SUM = 1.0
W_LINE = 1.4
OVER_LIMIT_PENALTY = 8.0


# =========================
# Models
# =========================
class Player(BaseModel):
    id: str
    name: str
    rating: int = Field(ge=0, le=200)
    active: bool = True
    noGK: bool = False  # 부상/사유로 GK 제외


class GenerateTeamsRequest(BaseModel):
    players: List[Player]
    teamCount: int = Field(ge=2, le=12)


class Team(BaseModel):
    name: str
    players: List[Player]
    sum: int
    avg: float
    noGKCount: int


class GenerateTeamsResponse(BaseModel):
    teams: List[Team]
    balance: Dict[str, Any]


class GKScheduleRequest(BaseModel):
    teams: List[Team]
    matchMinutes: int = Field(ge=1, le=200)
    segmentMinutes: int = Field(ge=1, le=10)


class GKSegment(BaseModel):
    startMin: int
    endMin: int
    durationMin: int
    gkPlayerId: Optional[str]
    gkPlayerName: str


class GKScheduleTeam(BaseModel):
    teamName: str
    eligibleCount: int
    segments: List[GKSegment]
    warning: Optional[str] = None


class GKScheduleResponse(BaseModel):
    schedules: List[GKScheduleTeam]


# =========================
# App
# =========================
app = FastAPI(title="Futsal Auto Teams")

# allow_origins=["*"] + allow_credentials=True 는 브라우저에서 충돌 가능 → False
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# =========================
# Helpers
# =========================
def _team_name(i: int) -> str:
    return chr(ord("A") + i)


def _team_sum(players: List[Player]) -> int:
    return sum(p.rating for p in players)


def _sorted_ratings(players: List[Player]) -> List[int]:
    return sorted([p.rating for p in players], reverse=True)


def _line_penalty_any_k(teams_players: List[List[Player]]) -> float:
    """
    k팀 라인 페널티:
    - 각 팀 내림차순 정렬 후 같은 라인(index)의 max-min 차이 누적
    - 차이가 LINE_LIMIT 넘으면 큰 페널티
    """
    if not teams_players:
        return 0.0

    sorted_lists = [_sorted_ratings(t) for t in teams_players]
    max_len = max((len(lst) for lst in sorted_lists), default=0)

    penalty = 0.0
    for r in range(max_len):
        vals = []
        for lst in sorted_lists:
            if r < len(lst):
                vals.append(lst[r])
        if len(vals) <= 1:
            continue

        diff = max(vals) - min(vals)
        penalty += diff
        if diff > LINE_LIMIT:
            penalty += (diff - LINE_LIMIT) * OVER_LIMIT_PENALTY

    sizes = [len(t) for t in teams_players]
    penalty += (max(sizes) - min(sizes)) * 5.0
    return penalty


def _score_partition(teams_players: List[List[Player]]) -> float:
    sums = [_team_sum(t) for t in teams_players]
    sum_diff = (max(sums) - min(sums)) if sums else 0
    line_pen = _line_penalty_any_k(teams_players)
    return W_SUM * sum_diff + W_LINE * line_pen


def _initial_snake(players_sorted: List[Player], k: int) -> List[List[Player]]:
    """
    초기 편성: 스네이크 드래프트
    - 강한 순서대로 팀 0..k-1, 다음은 k-1..0 반복
    """
    teams = [[] for _ in range(k)]
    forward = True
    idx = 0
    for p in players_sorted:
        t = idx if forward else (k - 1 - idx)
        teams[t].append(p)
        idx += 1
        if idx == k:
            idx = 0
            forward = not forward
    return teams


def _try_improve_by_swaps(teams_players: List[List[Player]], iterations: int = SWAP_ITERS) -> List[List[Player]]:
    """
    랜덤 스왑(두 팀에서 1명씩 교환)으로 점수 개선.
    - 팀 인원수는 유지됩니다.
    """
    best = [t[:] for t in teams_players]
    best_score = _score_partition(best)

    for _ in range(iterations):
        a, b = random.sample(range(len(best)), 2)
        if not best[a] or not best[b]:
            continue

        ia = random.randrange(len(best[a]))
        ib = random.randrange(len(best[b]))

        cand = [t[:] for t in best]
        cand[a][ia], cand[b][ib] = cand[b][ib], cand[a][ia]

        s = _score_partition(cand)
        if s < best_score:
            best, best_score = cand, s

    return best


def _strength_for_handicap(team_players: List[Player]) -> float:
    """
    '강팀' 판단 점수:
    - 총점 + 에이스(1번) 가중
    """
    s = _team_sum(team_players)
    top = max((p.rating for p in team_players), default=0)
    return s + 0.3 * top


# =========================
# Core: Team generation (라인 + 깍두기 + 인원분배 보장)
# =========================
def generate_teams(players: List[Player], k: int) -> List[Team]:
    active_players = [p for p in players if p.active]

    # 팀당 최소 5명
    if len(active_players) < k * 5:
        max_teams = max(1, len(active_players) // 5)
        raise HTTPException(
            status_code=400,
            detail={
                "message": "팀당 최소 5명 규칙 때문에 현재 설정으로는 팀 구성이 불가능합니다.",
                "activePlayers": len(active_players),
                "requestedTeams": k,
                "maxTeamsAllowed": max_teams,
                "minPlayersRequired": k * 5,
            },
        )

    # 강한 순 정렬
    active_players = sorted(active_players, key=lambda p: p.rating, reverse=True)

    # ✅ 인원 분배 목표:
    # 예) 17명 3팀 -> target_max=6, target_min=5 => 6/6/5만 가능 (7/5/5 불가)
    n = len(active_players)
    target_max = (n + k - 1) // k   # ceil(n/k)
    target_min = n // k            # floor(n/k)

    # base는 모두 최소 인원(target_min)씩 채우는 인원
    base_size = target_min * k
    base_players = active_players[:base_size]                 # 균등 편성(동일 인원)
    extras = sorted(active_players[base_size:], key=lambda p: p.rating)  # 남는 인원(최약체부터)

    # base_players로 균등 팀 만들고 라인 최적화
    teams_players = _initial_snake(base_players, k)
    teams_players = _try_improve_by_swaps(teams_players, iterations=SWAP_ITERS)
    teams_players = [sorted(t, key=lambda p: p.rating, reverse=True) for t in teams_players]

    # ✅ (핵심) extras 배정:
    # - 강팀부터 주되,
    # - 어떤 팀도 target_max(ceil) 넘지 않게
    # -> 결과 인원은 항상 target_max/target_min 조합으로만 나옵니다.
    for extra in extras:
        candidates = [i for i in range(k) if len(teams_players[i]) < target_max]
        if not candidates:
            # 이론상 거의 없음(안전장치)
            candidates = list(range(k))

        strongest_idx = max(candidates, key=lambda i: _strength_for_handicap(teams_players[i]))
        teams_players[strongest_idx].append(extra)
        teams_players[strongest_idx].sort(key=lambda p: p.rating, reverse=True)

    # Team 모델 패킹
    teams: List[Team] = []
    for i, ps in enumerate(teams_players):
        s = sum(p.rating for p in ps)
        avg = round((s / len(ps)) if ps else 0.0, 2)
        teams.append(
            Team(
                name=_team_name(i),
                players=ps,
                sum=s,
                avg=avg,
                noGKCount=sum(1 for p in ps if p.noGK),
            )
        )

    return teams


# =========================
# GK Schedule
# - 기본: 팀별 라운드로빈
# - 개선: "2팀일 때" 라인/능력치 매칭 + ±7 + 사용횟수 균등
# =========================
def build_gk_schedule_for_team(team: Team, match_minutes: int, seg_minutes: int) -> GKScheduleTeam:
    eligible = [p for p in team.players if not p.noGK]
    segments: List[GKSegment] = []

    if seg_minutes <= 0:
        seg_minutes = 2

    warning = None
    if len(eligible) == 0:
        warning = "GK 가능한 선수가 0명입니다(noGK 체크 확인 필요)."
    elif len(eligible) == 1:
        warning = "GK 가능한 선수가 1명뿐이라 반복 배정됩니다."

    start = 0
    idx = 0
    while start < match_minutes:
        end = min(start + seg_minutes, match_minutes)
        dur = end - start

        if len(eligible) == 0:
            gk_id = None
            gk_name = "없음"
        else:
            p = eligible[idx % len(eligible)]
            gk_id = p.id
            gk_name = p.name
            idx += 1

        segments.append(
            GKSegment(
                startMin=start,
                endMin=end,
                durationMin=dur,
                gkPlayerId=gk_id,
                gkPlayerName=gk_name,
            )
        )
        start = end

    return GKScheduleTeam(
        teamName=team.name,
        eligibleCount=len(eligible),
        segments=segments,
        warning=warning,
    )


def _pick_least_used(eligible_sorted: List[Player], used: Dict[str, int], pointer: int) -> Tuple[Optional[Player], int]:
    if not eligible_sorted:
        return None, pointer

    min_used = min(used.get(p.id, 0) for p in eligible_sorted)
    candidates = [p for p in eligible_sorted if used.get(p.id, 0) == min_used]
    p = candidates[pointer % len(candidates)]
    pointer += 1
    return p, pointer


def _pick_match(
    eligible_sorted: List[Player],
    used: Dict[str, int],
    target_rating: int,
    tol: int = GK_TOLERANCE,
) -> Optional[Player]:
    if not eligible_sorted:
        return None

    within = [p for p in eligible_sorted if abs(p.rating - target_rating) <= tol]
    pool = within if within else eligible_sorted

    pool_sorted = sorted(
        pool,
        key=lambda p: (used.get(p.id, 0), abs(p.rating - target_rating))
    )
    return pool_sorted[0] if pool_sorted else None


def build_gk_schedule_two_teams(
    team_a: Team,
    team_b: Team,
    match_minutes: int,
    seg_minutes: int,
    tol: int = GK_TOLERANCE,
) -> List[GKScheduleTeam]:
    if seg_minutes <= 0:
        seg_minutes = 2

    eligible_a = sorted([p for p in team_a.players if not p.noGK], key=lambda p: p.rating, reverse=True)
    eligible_b = sorted([p for p in team_b.players if not p.noGK], key=lambda p: p.rating, reverse=True)

    used_a: Dict[str, int] = {}
    used_b: Dict[str, int] = {}

    warn_a = None
    warn_b = None
    if len(eligible_a) == 0:
        warn_a = "GK 가능한 선수가 0명입니다(noGK 체크 확인 필요)."
    elif len(eligible_a) == 1:
        warn_a = "GK 가능한 선수가 1명뿐이라 반복 배정됩니다."

    if len(eligible_b) == 0:
        warn_b = "GK 가능한 선수가 0명입니다(noGK 체크 확인 필요)."
    elif len(eligible_b) == 1:
        warn_b = "GK 가능한 선수가 1명뿐이라 반복 배정됩니다."

    seg_count = math.ceil(match_minutes / seg_minutes)

    segs_a: List[GKSegment] = []
    segs_b: List[GKSegment] = []

    ptr_a = 0
    ptr_b = 0

    for s in range(seg_count):
        start = s * seg_minutes
        end = min(start + seg_minutes, match_minutes)
        dur = end - start

        # anchor를 번갈아가며 (공평)
        if s % 2 == 0:
            # A anchor
            anchor, ptr_a = _pick_least_used(eligible_a, used_a, ptr_a)
            if anchor is None:
                a_id, a_name, a_rating = None, "없음", 0
            else:
                a_id, a_name, a_rating = anchor.id, anchor.name, anchor.rating
                used_a[a_id] = used_a.get(a_id, 0) + 1

            match = _pick_match(eligible_b, used_b, a_rating, tol=tol)
            if match is None:
                b_id, b_name = None, "없음"
            else:
                b_id, b_name = match.id, match.name
                used_b[b_id] = used_b.get(b_id, 0) + 1

        else:
            # B anchor
            anchor, ptr_b = _pick_least_used(eligible_b, used_b, ptr_b)
            if anchor is None:
                b_id, b_name, b_rating = None, "없음", 0
            else:
                b_id, b_name, b_rating = anchor.id, anchor.name, anchor.rating
                used_b[b_id] = used_b.get(b_id, 0) + 1

            match = _pick_match(eligible_a, used_a, b_rating, tol=tol)
            if match is None:
                a_id, a_name = None, "없음"
            else:
                a_id, a_name = match.id, match.name
                used_a[a_id] = used_a.get(a_id, 0) + 1

        segs_a.append(
            GKSegment(
                startMin=start,
                endMin=end,
                durationMin=dur,
                gkPlayerId=a_id,
                gkPlayerName=a_name,
            )
        )
        segs_b.append(
            GKSegment(
                startMin=start,
                endMin=end,
                durationMin=dur,
                gkPlayerId=b_id,
                gkPlayerName=b_name,
            )
        )

    return [
        GKScheduleTeam(teamName=team_a.name, eligibleCount=len(eligible_a), segments=segs_a, warning=warn_a),
        GKScheduleTeam(teamName=team_b.name, eligibleCount=len(eligible_b), segments=segs_b, warning=warn_b),
    ]


# =========================
# Routes
# =========================
@app.get("/health")
def health():
    return {"ok": True}


@app.post("/api/teams/generate", response_model=GenerateTeamsResponse)
def api_generate_teams(req: GenerateTeamsRequest):
    teams = generate_teams(req.players, req.teamCount)

    sums = [t.sum for t in teams]
    max_sum = max(sums) if sums else 0
    min_sum = min(sums) if sums else 0

    balance = {
        "teamCount": req.teamCount,
        "playerCountActive": len([p for p in req.players if p.active]),
        "maxSum": max_sum,
        "minSum": min_sum,
        "diff": max_sum - min_sum,
    }

    return GenerateTeamsResponse(teams=teams, balance=balance)


@app.post("/api/gk/schedule", response_model=GKScheduleResponse)
def api_gk_schedule(req: GKScheduleRequest):
    # ✅ 2팀일 때만 "라인 매칭 GK(±7)" 적용
    if len(req.teams) == 2:
        schedules = build_gk_schedule_two_teams(
            req.teams[0],
            req.teams[1],
            req.matchMinutes,
            req.segmentMinutes,
            tol=GK_TOLERANCE,
        )
        return GKScheduleResponse(schedules=schedules)

    # 3팀 이상은 기존 로테이션 유지(대진표가 없어서)
    schedules = [build_gk_schedule_for_team(t, req.matchMinutes, req.segmentMinutes) for t in req.teams]
    return GKScheduleResponse(schedules=schedules)
