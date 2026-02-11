from __future__ import annotations

from typing import List, Optional, Dict, Any, Tuple
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


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


app = FastAPI(title="Futsal Auto Teams")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],

    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _team_name(i: int) -> str:
    return chr(ord("A") + i)


def improve_by_swaps(teams: List[Team], iterations: int = 600) -> List[Team]:
    import random

    def spread(ts: List[Team]) -> int:
        sums = [t.sum for t in ts]
        return max(sums) - min(sums) if sums else 0

    ts = [Team(**t.model_dump()) for t in teams]
    current_spread = spread(ts)

    for _ in range(iterations):
        a, b = random.sample(range(len(ts)), 2)
        ta, tb = ts[a], ts[b]
        if not ta.players or not tb.players:
            continue

        pa = random.choice(ta.players)
        pb = random.choice(tb.players)

        new_sum_a = ta.sum - pa.rating + pb.rating
        new_sum_b = tb.sum - pb.rating + pa.rating

        old_a_sum, old_b_sum = ta.sum, tb.sum
        ta.sum, tb.sum = new_sum_a, new_sum_b

        new_spread = spread(ts)

        if new_spread <= current_spread:
            ia = ta.players.index(pa)
            ib = tb.players.index(pb)
            ta.players[ia], tb.players[ib] = pb, pa
            current_spread = new_spread
        else:
            ta.sum, tb.sum = old_a_sum, old_b_sum

    return ts


def generate_teams(players: List[Player], k: int) -> List[Team]:
    active_players = [p for p in players if p.active]

    # ✅ 팀당 최소 5명 강제
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

    active_players.sort(key=lambda p: p.rating, reverse=True)

    buckets: List[Dict[str, Any]] = []
    for i in range(k):
        buckets.append({"name": _team_name(i), "players": [], "sum": 0, "noGK": 0})

    for p in active_players:
        def score(bucket: Dict[str, Any]) -> Tuple[int, int, int]:
            size = len(bucket["players"])
            s = bucket["sum"]
            no_gk = bucket["noGK"]
            return (size, s, no_gk if p.noGK else 0)

        best = min(buckets, key=score)
        best["players"].append(p)
        best["sum"] += p.rating
        if p.noGK:
            best["noGK"] += 1

    teams: List[Team] = []
    for b in buckets:
        ps = b["players"]
        s = b["sum"]
        avg = (s / len(ps)) if ps else 0.0
        teams.append(
            Team(
                name=b["name"],
                players=ps,
                sum=s,
                avg=round(avg, 2),
                noGKCount=b["noGK"],
            )
        )

    teams = improve_by_swaps(teams, iterations=600)

    for t in teams:
        t.sum = sum(p.rating for p in t.players)
        t.avg = round((t.sum / len(t.players)) if t.players else 0.0, 2)
        t.noGKCount = sum(1 for p in t.players if p.noGK)

    return teams


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
    schedules = [build_gk_schedule_for_team(t, req.matchMinutes, req.segmentMinutes) for t in req.teams]
    return GKScheduleResponse(schedules=schedules)
