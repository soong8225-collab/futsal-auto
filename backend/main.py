from __future__ import annotations

from typing import List, Optional, Dict, Any, Tuple
import random

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


# =========================
# Settings (요청 반영)
# =========================
LINE_LIMIT = 10          # 라인(1번vs1번...) 허용 차이
GK_TOLERANCE = 7         # GK 매칭 ±7 (추후 GK API 개선에 사용 가능)
SWAP_ITERS = 900         # 스왑 탐색 횟수 (인원 10~25명 정도면 충분히 빠름)

# 점수 가중치 (체감 밸런스에 라인을 더 중요하게)
W_SUM = 1.0
W_LINE = 1.4
OVER_LIMIT_PENALTY = 8.0  # 라인 제한 초과 시 페널티


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

# NOTE:
# allow_origins=["*"] 일 때 allow_credentials=True 는 브라우저에서 막힐 수 있어 False로 둡니다.
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
    k팀 일반화 라인 페널티:
    - 각 팀을 내림차순 정렬했을 때 같은 라인(인덱스)의 max-min 차이를 누적
    - 차이가 LINE_LIMIT를 넘으면 큰 페널티 추가
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

    # 인원수 차이가 큰 경우(기본은 동일 인원으로 만들지만 extras 붙일 수 있으니 약한 페널티)
    sizes = [len(t) for t in teams_players]
    penalty += (max(sizes) - min(sizes)) * 5.0

    return penalty


def _score_partition(teams_players: List[List[Player]]) -> float:
    """
    낮을수록 좋은 팀편성 점수:
    - 팀 총점 격차 + 라인 매치업 격차
    """
    sums = [_team_sum(t) for t in teams_players]
    sum_diff = (max(sums) - min(sums)) if sums else 0
    line_pen = _line_penalty_any_k(teams_players)
    return W_SUM * sum_diff + W_LINE * line_pen


def _initial_snake(players_sorted: List[Player], k: int) -> List[List[Player]]:
    """
    초기 편성: 스네이크 드래프트
    - 강한 순서대로 팀 0..k-1, 다음은 k-1..0 반복
    - base_players는 k로 나누어떨어지게 들어오도록 설계(동일 인원 유지)
    """
    teams = [[] for _ in range(k)]
    forward = True
    idx = 0
    for p in players_sorted:
        if forward:
            t = idx
        else:
            t = (k - 1) - idx

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
# Core: Team generation (라인 + 깍두기)
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

    # 강한 순서대로 정렬
    active_players = sorted(active_players, key=lambda p: p.rating, reverse=True)

    # -------------------------
    # (핵심) 깍두기 규칙 준비:
    # base는 k로 나누어떨어지게 팀 균등 인원 편성
    # extras(남는 인원)는 최약체부터, "강팀"에 붙여 핸디캡
    # -------------------------
    base_size = (len(active_players) // k) * k
    base_players = active_players[:base_size]
    extras = sorted(active_players[base_size:], key=lambda p: p.rating)  # 최약체부터

    # base_players로 동일 인원 팀 생성 + 라인 최적화
    teams_players = _initial_snake(base_players, k)
    teams_players = _try_improve_by_swaps(teams_players, iterations=SWAP_ITERS)

    # 팀 내부 정렬(라인 비교 정확히)
    teams_players = [sorted(t, key=lambda p: p.rating, reverse=True) for t in teams_players]

    # -------------------------
    # (핵심) 깍두기 적용:
    # 남는 인원은 항상 "강팀"이 가져간다
    # -------------------------
    for extra in extras:
        strongest_idx = max(range(k), key=lambda i: _strength_for_handicap(teams_players[i]))
        teams_players[strongest_idx].append(extra)
        teams_players[strongest_idx].sort(key=lambda p: p.rating, reverse=True)

    # Team 모델로 패킹
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
# GK schedule (기존 유지)
# - 지금 단계에서는 팀편성/깍두기 먼저
# - 이후 2팀일 때 GK 라인매칭(±7)로 개선 가능
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
        # 참고용: 라인 패널티도 같이 보고 싶으면 아래 주석 해제 가능
        # "linePenalty": _line_penalty_any_k([t.players for t in teams]),
    }

    return GenerateTeamsResponse(teams=teams, balance=balance)


@app.post("/api/gk/schedule", response_model=GKScheduleResponse)
def api_gk_schedule(req: GKScheduleRequest):
    schedules = [build_gk_schedule_for_team(t, req.matchMinutes, req.segmentMinutes) for t in req.teams]
    return GKScheduleResponse(schedules=schedules)
