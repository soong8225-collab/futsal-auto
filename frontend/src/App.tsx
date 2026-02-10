import { useEffect, useMemo, useState } from "react";
import "./App.css";

type Player = {
  id: string;
  name: string;
  rating: number;
  active: boolean;
  noGK: boolean;
};

type Team = {
  name: string;
  players: Player[];
  sum: number;
  avg: number;
  noGKCount: number;
};

type TeamsResponse = {
  teams: Team[];
  balance: {
    teamCount: number;
    playerCountActive: number;
    maxSum: number;
    minSum: number;
    diff: number;
  };
};

type GKSegment = {
  startMin: number;
  endMin: number;
  durationMin: number;
  gkPlayerId: string | null;
  gkPlayerName: string;
};

type GKScheduleTeam = {
  teamName: string;
  eligibleCount: number;
  segments: GKSegment[];
  warning?: string | null;
};

type GKResponse = {
  schedules: GKScheduleTeam[];
};

const API_BASE = "http://localhost:8000";

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function loadPlayers(): Player[] {
  try {
    const raw = localStorage.getItem("futsal_players_v1");
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function savePlayers(players: Player[]) {
  localStorage.setItem("futsal_players_v1", JSON.stringify(players));
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

export default function App() {
  const [players, setPlayers] = useState<Player[]>(() => loadPlayers());

  const [name, setName] = useState("");
  const [rating, setRating] = useState<number>(80);
  const [active, setActive] = useState(true);
  const [noGK, setNoGK] = useState(false);

  const [teamCount, setTeamCount] = useState(2);
  const [matchMinutes, setMatchMinutes] = useState(20);
  const [segmentMinutes, setSegmentMinutes] = useState(2);

  const [teams, setTeams] = useState<Team[] | null>(null);
  const [balance, setBalance] = useState<TeamsResponse["balance"] | null>(null);
  const [gkSchedules, setGkSchedules] = useState<GKScheduleTeam[] | null>(null);

  const activeCount = useMemo(() => players.filter((p) => p.active).length, [players]);
  const maxTeamsAllowed = useMemo(() => Math.floor(activeCount / 5), [activeCount]);

  useEffect(() => savePlayers(players), [players]);

  function addPlayer() {
    const trimmed = name.trim();
    if (!trimmed) return;

    const p: Player = {
      id: uid(),
      name: trimmed,
      rating: Math.max(0, Math.min(200, Number(rating) || 0)),
      active,
      noGK,
    };

    setPlayers((prev) => [p, ...prev]);
    setName("");
    setRating(80);
    setActive(true);
    setNoGK(false);
  }

  function removePlayer(id: string) {
    setPlayers((prev) => prev.filter((p) => p.id !== id));
  }

  function togglePlayer(id: string, key: "active" | "noGK") {
    setPlayers((prev) => prev.map((p) => (p.id === id ? { ...p, [key]: !p[key] } : p)));
  }

  async function generateTeams() {
    setGkSchedules(null);

    if (maxTeamsAllowed < 2) {
      alert(`현재 참석 ${activeCount}명으로는 팀당 최소 5명 규칙 때문에 팀 구성이 불가능합니다.\n(최소 10명 필요)`);
      return;
    }
    if (teamCount > maxTeamsAllowed) {
      alert(`현재 참석 ${activeCount}명 → 가능한 최대 팀 수는 ${maxTeamsAllowed}팀입니다.\n팀 수를 줄여주세요.`);
      return;
    }

    const res = await fetch(`${API_BASE}/api/teams/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ players, teamCount }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => null);
      if (err?.detail?.message) {
        alert(
          `${err.detail.message}\n` +
            `참석: ${err.detail.activePlayers}명\n` +
            `요청 팀 수: ${err.detail.requestedTeams}팀\n` +
            `가능 최대 팀 수: ${err.detail.maxTeamsAllowed}팀\n` +
            `필요 최소 인원: ${err.detail.minPlayersRequired}명`
        );
      } else {
        alert("팀 편성 API 호출 실패");
      }
      return;
    }

    const data: TeamsResponse = await res.json();
    setTeams(data.teams);
    setBalance(data.balance);
  }

  async function generateGK() {
    if (!teams) return;

    const res = await fetch(`${API_BASE}/api/gk/schedule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teams, matchMinutes, segmentMinutes }),
    });

    if (!res.ok) {
      alert("GK 스케줄 API 호출 실패");
      return;
    }

    const data: GKResponse = await res.json();
    setGkSchedules(data.schedules);
  }

  return (
    <div className="container">
      <div className="header">
        <h1 className="title">풋살 자동 팀 편성 + GK 로테이션</h1>
        <p className="sub">선수 입력 → 팀 수 선택 → 팀 편성 → 경기시간/교대단위 → GK 스케줄</p>
      </div>

      <div className="grid">
        {/* LEFT: Players */}
        <div className="card">
          <h2>선수 등록</h2>

          <div className="row">
            <input className="input" style={{ flex: 1, minWidth: 140 }} placeholder="이름" value={name} onChange={(e) => setName(e.target.value)} />
            <input className="input" style={{ width: 110 }} type="number" placeholder="총점" value={rating} onChange={(e) => setRating(Number(e.target.value))} />
            <button className="btn" onClick={addPlayer}>추가</button>
          </div>

          <div className="row" style={{ marginTop: 10 }}>
            <label className="badge">
              <input type="checkbox" checked={active} onChange={() => setActive(!active)} />
              오늘 참석
            </label>
            <label className="badge">
              <input type="checkbox" checked={noGK} onChange={() => setNoGK(!noGK)} />
              GK 제외(부상/사유)
            </label>

            <span className="muted" style={{ marginLeft: "auto" }}>
              참석 <b>{activeCount}</b> / 전체 <b>{players.length}</b>
            </span>
          </div>

          <div className="tableWrap">
            <table>
              <thead>
                <tr>
                  <th>이름</th>
                  <th>총점</th>
                  <th>참석</th>
                  <th>GK 제외</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {players.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted">아직 선수가 없습니다. 위에서 추가해주세요.</td>
                  </tr>
                )}

                {players.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td>{p.rating}</td>
                    <td>
                      <input type="checkbox" checked={p.active} onChange={() => togglePlayer(p.id, "active")} />
                    </td>
                    <td>
                      <input type="checkbox" checked={p.noGK} onChange={() => togglePlayer(p.id, "noGK")} />
                    </td>
                    <td>
                      <button className="btn secondary" onClick={() => removePlayer(p.id)}>삭제</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* RIGHT: Controls + Results */}
        <div className="section">
          <div className="card">
            <h2>편성 설정</h2>

            <div className="row">
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div className="muted">팀 수(K)</div>
                <input className="input" style={{ width: 160 }} type="number" min={2} max={12} value={teamCount} onChange={(e) => setTeamCount(Number(e.target.value))} />
                <div className="muted" style={{ fontSize: 12 }}>
                  현재 참석 {activeCount}명 → 최대 <b>{maxTeamsAllowed}</b>팀 가능(팀당 최소 5명)
                </div>
              </div>

              <button className="btn" onClick={generateTeams} style={{ marginLeft: "auto" }}>
                팀 편성하기
              </button>
            </div>

            {balance && (
              <div className="kpi" style={{ marginTop: 10 }}>
                <div>참석 인원: <b>{balance.playerCountActive}</b>명 / 팀 수: <b>{balance.teamCount}</b></div>
                <div>팀 총점 diff: <b>{balance.diff}</b> (max {balance.maxSum} / min {balance.minSum})</div>
              </div>
            )}
          </div>

          <div className="card">
            <h2>팀 결과</h2>

            {!teams && <div className="muted">아직 팀 편성을 하지 않았습니다.</div>}

            {teams && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {teams.map((t) => (
                  <div key={t.name} className="card" style={{ padding: 12 }}>
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <b>팀 {t.name}</b>
                      <span className="muted">인원 {t.players.length} / 합 {t.sum} / avg {t.avg}</span>
                    </div>

                    <div className="pills">
                      {t.players.map((p) => (
                        <span key={p.id} className={`pill ${p.noGK ? "gkx" : ""}`}>
                          {p.name}({p.rating}){p.noGK ? " •GKX" : ""}
                        </span>
                      ))}
                    </div>

                    <div className="muted" style={{ marginTop: 8 }}>
                      GK 제외 인원: <b>{t.noGKCount}</b>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <h2>GK 로테이션</h2>

            <div className="row">
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div className="muted">경기 시간(분)</div>
                <input className="input" style={{ width: 160 }} type="number" min={1} max={200} value={matchMinutes} onChange={(e) => setMatchMinutes(Number(e.target.value))} />
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div className="muted">교대 단위(분)</div>
                <input className="input" style={{ width: 160 }} type="number" min={1} max={10} value={segmentMinutes} onChange={(e) => setSegmentMinutes(Number(e.target.value))} />
              </div>

              <button className="btn" onClick={generateGK} disabled={!teams} style={{ marginLeft: "auto" }}>
                GK 스케줄 생성
              </button>
            </div>

            {gkSchedules && (
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 12 }}>
                {gkSchedules.map((s) => (
                  <div key={s.teamName} className="card" style={{ padding: 12 }}>
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <b>팀 {s.teamName}</b>
                      <span className="muted">GK 가능 인원: {s.eligibleCount}</span>
                    </div>

                    {s.warning && (
                      <div className="kpi" style={{ marginTop: 10, background: "#fff8e1" }}>
                        ⚠ {s.warning}
                      </div>
                    )}

                    <div className="tableWrap" style={{ marginTop: 10, maxHeight: 280 }}>
                      <table>
                        <thead>
                          <tr>
                            <th>시간</th>
                            <th>GK</th>
                            <th>구간(분)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {s.segments.map((seg, i) => (
                            <tr key={i}>
                              <td>{pad2(seg.startMin)}~{pad2(seg.endMin)}</td>
                              <td>{seg.gkPlayerName}</td>
                              <td>{seg.durationMin}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}
