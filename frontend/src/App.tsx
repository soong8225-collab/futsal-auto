import { useEffect, useMemo, useState } from "react";
import "./App.css";

type Player = {
  id: string;
  name: string;
  rating: number;
  noGK: boolean; // 상시 GK 제외(부상/사유)
};

type PlayerForApi = {
  id: string;
  name: string;
  rating: number;
  active: boolean; // 해당 구장/날짜 참석 여부
  noGK: boolean;
};

type Team = {
  name: string;
  players: PlayerForApi[];
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

type Court = "A" | "B";

type SavedRound = {
  round: number;            // 1,2,3...
  court: Court;             // A/B
  teamCount: number;        // 2 or 3
  teams: Team[];
  balance: TeamsResponse["balance"];
  matchMinutes: number;
  segmentMinutes: number;
  gkSchedules?: GKScheduleTeam[] | null;
  createdAt: number;
};

type AttendanceRecord = {
  date: string; // YYYY-MM-DD
  presentAIds: string[];
  presentBIds: string[];
  rounds: SavedRound[]; // 날짜별 라운드 기록(구장별 포함)
  createdAt: number;
  updatedAt: number;
};

const API_BASE = "https://futsal-auto.onrender.com";

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function todayStr() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

const LS_ROSTER = "futsal_roster_v3";
const LS_ATT = "futsal_attendance_v3";

function loadRoster(): Player[] {
  try {
    const raw = localStorage.getItem(LS_ROSTER);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveRoster(players: Player[]) {
  localStorage.setItem(LS_ROSTER, JSON.stringify(players));
}

function loadAttendanceMap(): Record<string, AttendanceRecord> {
  try {
    const raw = localStorage.getItem(LS_ATT);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveAttendanceMap(map: Record<string, AttendanceRecord>) {
  localStorage.setItem(LS_ATT, JSON.stringify(map));
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function courtLabel(c: Court) {
  return c === "A" ? "A구장" : "B구장";
}

export default function App() {
  // 선수 마스터(저장)
  const [roster, setRoster] = useState<Player[]>(() => loadRoster());

  // 날짜별 기록(저장)
  const [attendanceMap, setAttendanceMap] = useState<Record<string, AttendanceRecord>>(
    () => loadAttendanceMap()
  );

  const [selectedDate, setSelectedDate] = useState<string>(() => todayStr());

  // 선수 추가 입력
  const [name, setName] = useState("");
  const [rating, setRating] = useState<number>(80);
  const [noGK, setNoGK] = useState(false);

  // 구장별 설정(팀 수 / GK 설정)
  const [teamCountA, setTeamCountA] = useState(2);
  const [teamCountB, setTeamCountB] = useState(2);
  const [matchMinutesA, setMatchMinutesA] = useState(20);
  const [segmentMinutesA, setSegmentMinutesA] = useState(2);
  const [matchMinutesB, setMatchMinutesB] = useState(20);
  const [segmentMinutesB, setSegmentMinutesB] = useState(2);

  // 구장별 결과(현재 화면에 보여줄 것)
  const [teamsA, setTeamsA] = useState<Team[] | null>(null);
  const [balanceA, setBalanceA] = useState<TeamsResponse["balance"] | null>(null);
  const [gkA, setGkA] = useState<GKScheduleTeam[] | null>(null);

  const [teamsB, setTeamsB] = useState<Team[] | null>(null);
  const [balanceB, setBalanceB] = useState<TeamsResponse["balance"] | null>(null);
  const [gkB, setGkB] = useState<GKScheduleTeam[] | null>(null);

  // 저장 반영
  useEffect(() => saveRoster(roster), [roster]);
  useEffect(() => saveAttendanceMap(attendanceMap), [attendanceMap]);

  // 선택 날짜 record 확보
  const selectedRecord = attendanceMap[selectedDate];

  useEffect(() => {
    // 날짜 바뀌면 화면 결과 초기화
    setTeamsA(null); setBalanceA(null); setGkA(null);
    setTeamsB(null); setBalanceB(null); setGkB(null);

    setAttendanceMap((prev) => {
      if (prev[selectedDate]) return prev;
      const now = Date.now();
      return {
        ...prev,
        [selectedDate]: {
          date: selectedDate,
          presentAIds: [],
          presentBIds: [],
          rounds: [],
          createdAt: now,
          updatedAt: now,
        },
      };
    });
  }, [selectedDate]);

  const presentASet = useMemo(() => new Set(selectedRecord?.presentAIds ?? []), [selectedRecord]);
  const presentBSet = useMemo(() => new Set(selectedRecord?.presentBIds ?? []), [selectedRecord]);

  // 구장별 API players 만들기
  const playersForApiA: PlayerForApi[] = useMemo(() => {
    return roster.map((p) => ({
      id: p.id, name: p.name, rating: p.rating, noGK: p.noGK,
      active: presentASet.has(p.id),
    }));
  }, [roster, presentASet]);

  const playersForApiB: PlayerForApi[] = useMemo(() => {
    return roster.map((p) => ({
      id: p.id, name: p.name, rating: p.rating, noGK: p.noGK,
      active: presentBSet.has(p.id),
    }));
  }, [roster, presentBSet]);

  const activeCountA = useMemo(() => playersForApiA.filter((p) => p.active).length, [playersForApiA]);
  const activeCountB = useMemo(() => playersForApiB.filter((p) => p.active).length, [playersForApiB]);

  const maxTeamsAllowedA = Math.floor(activeCountA / 5);
  const maxTeamsAllowedB = Math.floor(activeCountB / 5);

  const dateList = useMemo(() => Object.keys(attendanceMap).sort((a, b) => (a < b ? 1 : -1)), [attendanceMap]);

  // --- 선수/참석 조작 ---
  function addPlayer() {
    const trimmed = name.trim();
    if (!trimmed) return;

    const p: Player = {
      id: uid(),
      name: trimmed,
      rating: Math.max(0, Math.min(200, Number(rating) || 0)),
      noGK,
    };
    setRoster((prev) => [p, ...prev]);
    setName("");
    setRating(80);
    setNoGK(false);
  }

  function removePlayer(id: string) {
    setRoster((prev) => prev.filter((p) => p.id !== id));
    setAttendanceMap((prev) => {
      const next = { ...prev };
      for (const d of Object.keys(next)) {
        const r = next[d];
        const a = r.presentAIds.filter((x) => x !== id);
        const b = r.presentBIds.filter((x) => x !== id);
        const rounds = r.rounds.map(rr => ({
          ...rr,
          teams: rr.teams.map(t => ({...t, players: t.players.filter(pp => pp.id !== id)}))
        }));
        next[d] = { ...r, presentAIds: a, presentBIds: b, rounds, updatedAt: Date.now() };
      }
      return next;
    });
  }

  function toggleNoGK(id: string) {
    setRoster((prev) => prev.map((p) => (p.id === id ? { ...p, noGK: !p.noGK } : p)));
  }

  // 참석 체크: A/B는 동시에 못 들어가게(자동 이동)
  function toggleCourtAttendance(court: Court, id: string) {
    setAttendanceMap((prev) => {
      const now = Date.now();
      const cur = prev[selectedDate]!;
      const setA = new Set(cur.presentAIds);
      const setB = new Set(cur.presentBIds);

      if (court === "A") {
        if (setA.has(id)) setA.delete(id);
        else { setA.add(id); setB.delete(id); }
      } else {
        if (setB.has(id)) setB.delete(id);
        else { setB.add(id); setA.delete(id); }
      }

      return {
        ...prev,
        [selectedDate]: {
          ...cur,
          presentAIds: Array.from(setA),
          presentBIds: Array.from(setB),
          updatedAt: now,
        },
      };
    });
  }

  function clearCourt(court: Court) {
    setAttendanceMap((prev) => {
      const now = Date.now();
      const cur = prev[selectedDate]!;
      return {
        ...prev,
        [selectedDate]: {
          ...cur,
          presentAIds: court === "A" ? [] : cur.presentAIds,
          presentBIds: court === "B" ? [] : cur.presentBIds,
          updatedAt: now,
        },
      };
    });
  }

  // --- 팀 생성/저장 ---
  async function generateTeamsForCourt(court: Court) {
    const players = court === "A" ? playersForApiA : playersForApiB;
    const teamCount = court === "A" ? teamCountA : teamCountB;
    const activeCount = court === "A" ? activeCountA : activeCountB;
    const maxTeamsAllowed = court === "A" ? maxTeamsAllowedA : maxTeamsAllowedB;

    if (maxTeamsAllowed < 2) {
      alert(`${courtLabel(court)} 참석 ${activeCount}명으로는 팀당 최소 5명 규칙 때문에 팀 구성이 불가능합니다.\n(최소 10명 필요)`);
      return;
    }
    if (teamCount > maxTeamsAllowed) {
      alert(`${courtLabel(court)} 참석 ${activeCount}명 → 가능한 최대 팀 수는 ${maxTeamsAllowed}팀입니다.\n팀 수를 줄여주세요.`);
      return;
    }

    const res = await fetch(`${API_BASE}/api/teams/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ players, teamCount }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => null);
      alert(err?.detail?.message ?? "팀 편성 실패");
      return;
    }

    const data: TeamsResponse = await res.json();

    if (court === "A") { setTeamsA(data.teams); setBalanceA(data.balance); setGkA(null); }
    else { setTeamsB(data.teams); setBalanceB(data.balance); setGkB(null); }

    // 라운드 기록 저장(자동으로 다음 라운드 번호 부여)
    setAttendanceMap((prev) => {
      const cur = prev[selectedDate]!;
      const nextRoundNum = (cur.rounds.filter(r => r.court === court).length) + 1;
      const mr = court === "A" ? matchMinutesA : matchMinutesB;
      const sr = court === "A" ? segmentMinutesA : segmentMinutesB;

      const saved: SavedRound = {
        round: nextRoundNum,
        court,
        teamCount,
        teams: data.teams,
        balance: data.balance,
        matchMinutes: mr,
        segmentMinutes: sr,
        gkSchedules: null,
        createdAt: Date.now(),
      };

      return {
        ...prev,
        [selectedDate]: {
          ...cur,
          rounds: [...cur.rounds, saved],
          updatedAt: Date.now(),
        },
      };
    });
  }

  async function generateGKForCourt(court: Court) {
    const teams = court === "A" ? teamsA : teamsB;
    const matchMinutes = court === "A" ? matchMinutesA : matchMinutesB;
    const segmentMinutes = court === "A" ? segmentMinutesA : segmentMinutesB;
    if (!teams) return;

    const res = await fetch(`${API_BASE}/api/gk/schedule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teams, matchMinutes, segmentMinutes }),
    });

    if (!res.ok) {
      alert("GK 스케줄 생성 실패");
      return;
    }

    const data: GKResponse = await res.json();
    if (court === "A") setGkA(data.schedules);
    else setGkB(data.schedules);

    // 가장 마지막 저장 라운드에 GK 저장(그 구장 마지막 라운드)
    setAttendanceMap((prev) => {
      const cur = prev[selectedDate]!;
      const idx = [...cur.rounds]
        .map((r, i) => ({ r, i }))
        .filter(x => x.r.court === court)
        .map(x => x.i)
        .pop();

      if (idx === undefined) return prev;

      const rounds = cur.rounds.slice();
      rounds[idx] = { ...rounds[idx], gkSchedules: data.schedules };
      return {
        ...prev,
        [selectedDate]: { ...cur, rounds, updatedAt: Date.now() },
      };
    });
  }

  function loadRoundToScreen(court: Court, roundNumber: number) {
    const r = attendanceMap[selectedDate]?.rounds.find(x => x.court === court && x.round === roundNumber);
    if (!r) return;

    if (court === "A") {
      setTeamCountA(r.teamCount);
      setMatchMinutesA(r.matchMinutes);
      setSegmentMinutesA(r.segmentMinutes);
      setTeamsA(r.teams);
      setBalanceA(r.balance);
      setGkA(r.gkSchedules ?? null);
    } else {
      setTeamCountB(r.teamCount);
      setMatchMinutesB(r.matchMinutes);
      setSegmentMinutesB(r.segmentMinutes);
      setTeamsB(r.teams);
      setBalanceB(r.balance);
      setGkB(r.gkSchedules ?? null);
    }
  }

  function clearRounds(court: Court) {
    setAttendanceMap((prev) => {
      const cur = prev[selectedDate]!;
      const rounds = cur.rounds.filter(r => r.court !== court);
      return { ...prev, [selectedDate]: { ...cur, rounds, updatedAt: Date.now() } };
    });

    if (court === "A") { setTeamsA(null); setBalanceA(null); setGkA(null); }
    else { setTeamsB(null); setBalanceB(null); setGkB(null); }
  }

  // 참석자 이름 보기
  const presentNamesA = useMemo(() => {
    const ids = attendanceMap[selectedDate]?.presentAIds ?? [];
    const s = new Set(ids);
    return roster.filter(p => s.has(p.id)).map(p => p.name);
  }, [attendanceMap, selectedDate, roster]);

  const presentNamesB = useMemo(() => {
    const ids = attendanceMap[selectedDate]?.presentBIds ?? [];
    const s = new Set(ids);
    return roster.filter(p => s.has(p.id)).map(p => p.name);
  }, [attendanceMap, selectedDate, roster]);

  const roundsA = useMemo(() => (attendanceMap[selectedDate]?.rounds ?? []).filter(r => r.court === "A"), [attendanceMap, selectedDate]);
  const roundsB = useMemo(() => (attendanceMap[selectedDate]?.rounds ?? []).filter(r => r.court === "B"), [attendanceMap, selectedDate]);

  return (
    <div style={{ padding: 20, maxWidth: 1200, margin: "0 auto" }}>
      <h1>풋살 운영 (A/B 2개 구장 + 날짜별 기록)</h1>

      {/* 날짜 선택 + 기록 목록 */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <b>날짜</b>
        <input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} />
        <span style={{ opacity: 0.75 }}>날짜별로 A/B 참석 + 라운드 결과가 저장됩니다(이 기기 브라우저 기준).</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16, marginBottom: 16 }}>
        {/* 선수 명단(저장됨) */}
        <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 12 }}>
          <h2>선수 명단(저장됨)</h2>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input placeholder="이름" value={name} onChange={(e) => setName(e.target.value)} />
            <input type="number" placeholder="총점" value={rating} onChange={(e) => setRating(Number(e.target.value))} />
            <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={noGK} onChange={() => setNoGK(!noGK)} />
              GK 제외(상시)
            </label>
            <button onClick={addPlayer}>추가</button>
          </div>

          <div style={{ marginTop: 10, overflow: "auto", borderTop: "1px solid #f0f0f0", paddingTop: 10 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", padding: 6 }}>이름</th>
                  <th style={{ textAlign: "left", padding: 6 }}>총점</th>
                  <th style={{ textAlign: "left", padding: 6 }}>A구장</th>
                  <th style={{ textAlign: "left", padding: 6 }}>B구장</th>
                  <th style={{ textAlign: "left", padding: 6 }}>GK 제외</th>
                  <th style={{ textAlign: "left", padding: 6 }}></th>
                </tr>
              </thead>
              <tbody>
                {roster.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ padding: 10, opacity: 0.7 }}>
                      아직 선수가 없습니다. 위에서 추가해 주세요.
                    </td>
                  </tr>
                )}
                {roster.map((p) => {
                  const inA = presentASet.has(p.id);
                  const inB = presentBSet.has(p.id);
                  return (
                    <tr key={p.id} style={{ borderTop: "1px solid #f5f5f5" }}>
                      <td style={{ padding: 6 }}>{p.name}</td>
                      <td style={{ padding: 6 }}>{p.rating}</td>
                      <td style={{ padding: 6 }}>
                        <input type="checkbox" checked={inA} onChange={() => toggleCourtAttendance("A", p.id)} />
                      </td>
                      <td style={{ padding: 6 }}>
                        <input type="checkbox" checked={inB} onChange={() => toggleCourtAttendance("B", p.id)} />
                      </td>
                      <td style={{ padding: 6 }}>
                        <input type="checkbox" checked={p.noGK} onChange={() => toggleNoGK(p.id)} />
                      </td>
                      <td style={{ padding: 6 }}>
                        <button onClick={() => removePlayer(p.id)}>삭제</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <div style={{ marginTop: 10, opacity: 0.75, fontSize: 13 }}>
              * A/B는 동시에 체크되지 않게 자동 이동됩니다.
            </div>
          </div>
        </div>

        {/* 날짜 기록 목록 */}
        <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 12 }}>
          <h2>기록 날짜 목록</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {dateList.length === 0 && <div style={{ opacity: 0.7 }}>아직 기록이 없습니다.</div>}
            {dateList.map((d) => {
              const r = attendanceMap[d];
              const a = r?.presentAIds?.length ?? 0;
              const b = r?.presentBIds?.length ?? 0;
              return (
                <button
                  key={d}
                  onClick={() => setSelectedDate(d)}
                  style={{
                    textAlign: "left",
                    padding: "10px 12px",
                    borderRadius: 10,
                    border: d === selectedDate ? "2px solid #333" : "1px solid #ddd",
                    background: "white",
                    cursor: "pointer",
                  }}
                >
                  <b>{d}</b> <span style={{ opacity: 0.7 }}>— A {a}명 / B {b}명</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* A/B 구장 운영 */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* A court */}
        <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 12 }}>
          <h2>A구장</h2>
          <div style={{ opacity: 0.85, marginBottom: 8 }}>
            참석 {activeCountA}명 (최대 {maxTeamsAllowedA}팀 가능, 팀당 최소 5명)
          </div>
          <div style={{ marginBottom: 10, opacity: 0.75 }}>
            참석자: {presentNamesA.length ? presentNamesA.join(", ") : "없음"}
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <label>
              팀 수&nbsp;
              <input type="number" value={teamCountA} onChange={(e) => setTeamCountA(Number(e.target.value))} />
            </label>
            <button onClick={() => generateTeamsForCourt("A")}>A구장 팀 편성(라운드 저장)</button>
            <button onClick={() => clearCourt("A")}>A구장 참석 초기화</button>
          </div>

          {balanceA && (
            <div style={{ marginTop: 10 }}>
              팀 점수 차이: <b>{balanceA.diff}</b> (max {balanceA.maxSum} / min {balanceA.minSum})
            </div>
          )}

          {teamsA && (
            <div style={{ marginTop: 12 }}>
              <b>현재 결과</b>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 8 }}>
                {teamsA.map((t) => (
                  <div key={t.name} style={{ border: "1px solid #f0f0f0", borderRadius: 10, padding: 10 }}>
                    <b>팀 {t.name}</b>
                    <div style={{ opacity: 0.75, marginTop: 6 }}>
                      인원 {t.players.length} / 합 {t.sum} / 평균 {t.avg}
                    </div>
                    <div style={{ marginTop: 8 }}>
                      {t.players.map((p) => (
                        <span key={p.id} style={{ display: "inline-block", marginRight: 8, marginBottom: 6 }}>
                          {p.name}({p.rating}){p.noGK ? "·GKX" : ""}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ marginTop: 14 }}>
            <b>GK 로테이션</b>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
              <label>
                경기(분)&nbsp;
                <input type="number" value={matchMinutesA} onChange={(e) => setMatchMinutesA(Number(e.target.value))} />
              </label>
              <label>
                교대(분)&nbsp;
                <input type="number" value={segmentMinutesA} onChange={(e) => setSegmentMinutesA(Number(e.target.value))} />
              </label>
              <button onClick={() => generateGKForCourt("A")} disabled={!teamsA}>
                GK 생성(마지막 라운드에 저장)
              </button>
            </div>

            {gkA && (
              <div style={{ marginTop: 10 }}>
                {gkA.map((s) => (
                  <div key={s.teamName} style={{ border: "1px solid #f0f0f0", borderRadius: 10, padding: 10, marginTop: 8 }}>
                    <b>팀 {s.teamName}</b>
                    <div style={{ opacity: 0.75, marginTop: 6 }}>GK 가능 인원: {s.eligibleCount}</div>
                    {s.warning && <div style={{ marginTop: 8, color: "#b45309" }}>⚠ {s.warning}</div>}
                    <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 10 }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: "left", padding: 6 }}>시간</th>
                          <th style={{ textAlign: "left", padding: 6 }}>GK</th>
                          <th style={{ textAlign: "left", padding: 6 }}>구간</th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.segments.map((seg, i) => (
                          <tr key={i} style={{ borderTop: "1px solid #f5f5f5" }}>
                            <td style={{ padding: 6 }}>{pad2(seg.startMin)}~{pad2(seg.endMin)}</td>
                            <td style={{ padding: 6 }}>{seg.gkPlayerName}</td>
                            <td style={{ padding: 6 }}>{seg.durationMin}분</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ marginTop: 14, borderTop: "1px solid #f3f3f3", paddingTop: 12 }}>
            <b>A구장 라운드 기록</b>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              {roundsA.length === 0 && <span style={{ opacity: 0.7 }}>아직 기록 없음</span>}
              {roundsA.map((r) => (
                <button key={r.round} onClick={() => loadRoundToScreen("A", r.round)}>
                  {r.round}R 보기
                </button>
              ))}
              {roundsA.length > 0 && <button onClick={() => clearRounds("A")}>A 라운드 기록 삭제</button>}
            </div>
          </div>
        </div>

        {/* B court */}
        <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 12 }}>
          <h2>B구장</h2>
          <div style={{ opacity: 0.85, marginBottom: 8 }}>
            참석 {activeCountB}명 (최대 {maxTeamsAllowedB}팀 가능, 팀당 최소 5명)
          </div>
          <div style={{ marginBottom: 10, opacity: 0.75 }}>
            참석자: {presentNamesB.length ? presentNamesB.join(", ") : "없음"}
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <label>
              팀 수&nbsp;
              <input type="number" value={teamCountB} onChange={(e) => setTeamCountB(Number(e.target.value))} />
            </label>
            <button onClick={() => generateTeamsForCourt("B")}>B구장 팀 편성(라운드 저장)</button>
            <button onClick={() => clearCourt("B")}>B구장 참석 초기화</button>
          </div>

          {balanceB && (
            <div style={{ marginTop: 10 }}>
              팀 점수 차이: <b>{balanceB.diff}</b> (max {balanceB.maxSum} / min {balanceB.minSum})
            </div>
          )}

          {teamsB && (
            <div style={{ marginTop: 12 }}>
              <b>현재 결과</b>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 8 }}>
                {teamsB.map((t) => (
                  <div key={t.name} style={{ border: "1px solid #f0f0f0", borderRadius: 10, padding: 10 }}>
                    <b>팀 {t.name}</b>
                    <div style={{ opacity: 0.75, marginTop: 6 }}>
                      인원 {t.players.length} / 합 {t.sum} / 평균 {t.avg}
                    </div>
                    <div style={{ marginTop: 8 }}>
                      {t.players.map((p) => (
                        <span key={p.id} style={{ display: "inline-block", marginRight: 8, marginBottom: 6 }}>
                          {p.name}({p.rating}){p.noGK ? "·GKX" : ""}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ marginTop: 14 }}>
            <b>GK 로테이션</b>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
              <label>
                경기(분)&nbsp;
                <input type="number" value={matchMinutesB} onChange={(e) => setMatchMinutesB(Number(e.target.value))} />
              </label>
              <label>
                교대(분)&nbsp;
                <input type="number" value={segmentMinutesB} onChange={(e) => setSegmentMinutesB(Number(e.target.value))} />
              </label>
              <button onClick={() => generateGKForCourt("B")} disabled={!teamsB}>
                GK 생성(마지막 라운드에 저장)
              </button>
            </div>

            {gkB && (
              <div style={{ marginTop: 10 }}>
                {gkB.map((s) => (
                  <div key={s.teamName} style={{ border: "1px solid #f0f0f0", borderRadius: 10, padding: 10, marginTop: 8 }}>
                    <b>팀 {s.teamName}</b>
                    <div style={{ opacity: 0.75, marginTop: 6 }}>GK 가능 인원: {s.eligibleCount}</div>
                    {s.warning && <div style={{ marginTop: 8, color: "#b45309" }}>⚠ {s.warning}</div>}
                    <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 10 }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: "left", padding: 6 }}>시간</th>
                          <th style={{ textAlign: "left", padding: 6 }}>GK</th>
                          <th style={{ textAlign: "left", padding: 6 }}>구간</th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.segments.map((seg, i) => (
                          <tr key={i} style={{ borderTop: "1px solid #f5f5f5" }}>
                            <td style={{ padding: 6 }}>{pad2(seg.startMin)}~{pad2(seg.endMin)}</td>
                            <td style={{ padding: 6 }}>{seg.gkPlayerName}</td>
                            <td style={{ padding: 6 }}>{seg.durationMin}분</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ marginTop: 14, borderTop: "1px solid #f3f3f3", paddingTop: 12 }}>
            <b>B구장 라운드 기록</b>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              {roundsB.length === 0 && <span style={{ opacity: 0.7 }}>아직 기록 없음</span>}
              {roundsB.map((r) => (
                <button key={r.round} onClick={() => loadRoundToScreen("B", r.round)}>
                  {r.round}R 보기
                </button>
              ))}
              {roundsB.length > 0 && <button onClick={() => clearRounds("B")}>B 라운드 기록 삭제</button>}
            </div>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 16, opacity: 0.75, fontSize: 13 }}>
        ※ 저장은 현재 “이 기기 브라우저”에 저장됩니다. 팀원 전체가 같은 기록을 공유하려면 다음 단계로 DB 저장을 붙이면 됩니다.
      </div>
    </div>
  );
}
