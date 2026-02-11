import { useEffect, useMemo, useState } from "react";
import "./App.css";

type Player = {
  id: string;
  name: string;
  rating: number;
  noGK: boolean; // 부상/사유로 GK 제외(상시 속성)
};

type AttendanceRecord = {
  date: string; // YYYY-MM-DD
  presentIds: string[]; // 참석한 player.id 목록
  note?: string;
  createdAt: number;
  updatedAt: number;
};

type PlayerForApi = {
  id: string;
  name: string;
  rating: number;
  active: boolean; // 오늘 참석 여부(날짜별)
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

const API_BASE = "https://futsal-auto.onrender.com"; // ✅ 배포된 백엔드 주소

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

const LS_ROSTER = "futsal_roster_v2";
const LS_ATT = "futsal_attendance_v2";

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

export default function App() {
  // 1) 마스터 선수 명단(항상 저장)
  const [roster, setRoster] = useState<Player[]>(() => loadRoster());

  // 2) 날짜별 참석 기록(항상 저장)
  const [attendanceMap, setAttendanceMap] = useState<Record<string, AttendanceRecord>>(
    () => loadAttendanceMap()
  );

  // 3) 현재 선택 날짜
  const [selectedDate, setSelectedDate] = useState<string>(() => todayStr());

  // 선수 추가 입력
  const [name, setName] = useState("");
  const [rating, setRating] = useState<number>(80);
  const [noGK, setNoGK] = useState(false);

  // 편성/스케줄
  const [teamCount, setTeamCount] = useState(2);
  const [matchMinutes, setMatchMinutes] = useState(20);
  const [segmentMinutes, setSegmentMinutes] = useState(2);

  const [teams, setTeams] = useState<Team[] | null>(null);
  const [balance, setBalance] = useState<TeamsResponse["balance"] | null>(null);
  const [gkSchedules, setGkSchedules] = useState<GKScheduleTeam[] | null>(null);

  // --- 저장 자동 반영 ---
  useEffect(() => saveRoster(roster), [roster]);
  useEffect(() => saveAttendanceMap(attendanceMap), [attendanceMap]);

  // --- 선택 날짜의 참석 목록 ---
  const selectedAttendance = attendanceMap[selectedDate];
  const presentSet = useMemo(() => new Set(selectedAttendance?.presentIds ?? []), [selectedAttendance]);

  // 선택 날짜 기준 API로 보낼 players(active 포함)
  const playersForApi: PlayerForApi[] = useMemo(() => {
    return roster.map((p) => ({
      id: p.id,
      name: p.name,
      rating: p.rating,
      noGK: p.noGK,
      active: presentSet.has(p.id),
    }));
  }, [roster, presentSet]);

  const activeCount = useMemo(() => playersForApi.filter((p) => p.active).length, [playersForApi]);
  const maxTeamsAllowed = useMemo(() => Math.floor(activeCount / 5), [activeCount]);

  // 날짜 바뀌면 결과 초기화(헷갈림 방지)
  useEffect(() => {
    setTeams(null);
    setBalance(null);
    setGkSchedules(null);

    // 선택한 날짜가 attendanceMap에 없으면 자동 생성(빈 참석)
    setAttendanceMap((prev) => {
      if (prev[selectedDate]) return prev;
      const now = Date.now();
      return {
        ...prev,
        [selectedDate]: {
          date: selectedDate,
          presentIds: [],
          createdAt: now,
          updatedAt: now,
        },
      };
    });
  }, [selectedDate]);

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
    // 로스터에서 제거 + 모든 날짜 참석 기록에서도 제거
    setRoster((prev) => prev.filter((p) => p.id !== id));
    setAttendanceMap((prev) => {
      const next: Record<string, AttendanceRecord> = { ...prev };
      for (const k of Object.keys(next)) {
        const r = next[k];
        const filtered = r.presentIds.filter((pid) => pid !== id);
        if (filtered.length !== r.presentIds.length) {
          next[k] = { ...r, presentIds: filtered, updatedAt: Date.now() };
        }
      }
      return next;
    });
  }

  function toggleNoGK(id: string) {
    setRoster((prev) => prev.map((p) => (p.id === id ? { ...p, noGK: !p.noGK } : p)));
  }

  function toggleAttendance(id: string) {
    setAttendanceMap((prev) => {
      const now = Date.now();
      const current = prev[selectedDate] ?? {
        date: selectedDate,
        presentIds: [],
        createdAt: now,
        updatedAt: now,
      };

      const set = new Set(current.presentIds);
      if (set.has(id)) set.delete(id);
      else set.add(id);

      return {
        ...prev,
        [selectedDate]: {
          ...current,
          presentIds: Array.from(set),
          updatedAt: now,
        },
      };
    });
  }

  function markAllPresent() {
    setAttendanceMap((prev) => {
      const now = Date.now();
      const current = prev[selectedDate] ?? {
        date: selectedDate,
        presentIds: [],
        createdAt: now,
        updatedAt: now,
      };
      return {
        ...prev,
        [selectedDate]: {
          ...current,
          presentIds: roster.map((p) => p.id),
          updatedAt: now,
        },
      };
    });
  }

  function clearPresent() {
    setAttendanceMap((prev) => {
      const now = Date.now();
      const current = prev[selectedDate] ?? {
        date: selectedDate,
        presentIds: [],
        createdAt: now,
        updatedAt: now,
      };
      return {
        ...prev,
        [selectedDate]: { ...current, presentIds: [], updatedAt: now },
      };
    });
  }

  const dateList = useMemo(() => {
    return Object.keys(attendanceMap).sort((a, b) => (a < b ? 1 : -1)); // 최신 날짜 위
  }, [attendanceMap]);

  const presentNamesForSelectedDate = useMemo(() => {
    const ids = attendanceMap[selectedDate]?.presentIds ?? [];
    const idSet = new Set(ids);
    return roster.filter((p) => idSet.has(p.id)).map((p) => p.name);
  }, [attendanceMap, selectedDate, roster]);

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
      body: JSON.stringify({ players: playersForApi, teamCount }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => null);
      alert(err?.detail?.message ?? "팀 편성 실패");
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
      alert("GK 스케줄 생성 실패");
      return;
    }

    const data: GKResponse = await res.json();
    setGkSchedules(data.schedules);
  }

  return (
    <div style={{ padding: 20, maxWidth: 1100, margin: "0 auto" }}>
      <h1>풋살 자동 팀 편성 + GK 로테이션</h1>

      {/* 날짜 선택/기록 */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
        <b>날짜</b>
        <input
          type="date"
          value={selectedDate}
          onChange={(e) => setSelectedDate(e.target.value)}
        />
        <span style={{ opacity: 0.75 }}>
          참석 {activeCount}명 / 전체 {roster.length}명 (팀당 최소 5명)
        </span>
        <button onClick={markAllPresent}>전원 참석</button>
        <button onClick={clearPresent}>참석 초기화</button>
      </div>

      {/* 날짜별 참석자 보기 */}
      <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 12, marginBottom: 16 }}>
        <b>{selectedDate} 참석자</b>
        <div style={{ marginTop: 8, opacity: 0.85 }}>
          {presentNamesForSelectedDate.length === 0 ? "없음" : presentNamesForSelectedDate.join(", ")}
        </div>

        <div style={{ marginTop: 10, opacity: 0.7, fontSize: 13 }}>
          날짜 기록 보기: 아래 “기록 날짜 목록”에서 원하는 날짜를 클릭하면 그날 참석자를 바로 볼 수 있습니다.
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 18 }}>
        {/* 선수 명단(마스터 저장) */}
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
                  <th style={{ textAlign: "left", padding: 6 }}>오늘 참석</th>
                  <th style={{ textAlign: "left", padding: 6 }}>GK 제외</th>
                  <th style={{ textAlign: "left", padding: 6 }}></th>
                </tr>
              </thead>
              <tbody>
                {roster.length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ padding: 10, opacity: 0.7 }}>
                      아직 선수가 없습니다. 위에서 추가해 주세요.
                    </td>
                  </tr>
                )}
                {playersForApi.map((p) => (
                  <tr key={p.id} style={{ borderTop: "1px solid #f5f5f5" }}>
                    <td style={{ padding: 6 }}>{p.name}</td>
                    <td style={{ padding: 6 }}>{p.rating}</td>
                    <td style={{ padding: 6 }}>
                      <input type="checkbox" checked={p.active} onChange={() => toggleAttendance(p.id)} />
                    </td>
                    <td style={{ padding: 6 }}>
                      <input type="checkbox" checked={p.noGK} onChange={() => toggleNoGK(p.id)} />
                    </td>
                    <td style={{ padding: 6 }}>
                      <button onClick={() => removePlayer(p.id)}>삭제</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* 기록 날짜 목록 */}
        <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 12 }}>
          <h2>기록 날짜 목록</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {dateList.length === 0 && <div style={{ opacity: 0.7 }}>아직 기록이 없습니다.</div>}
            {dateList.map((d) => {
              const cnt = attendanceMap[d]?.presentIds?.length ?? 0;
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
                  <b>{d}</b> <span style={{ opacity: 0.7 }}>— 참석 {cnt}명</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* 팀 편성 */}
      <div style={{ marginTop: 18, border: "1px solid #eee", borderRadius: 10, padding: 12 }}>
        <h2>팀 편성</h2>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <label>
            팀 수(K)&nbsp;
            <input type="number" value={teamCount} onChange={(e) => setTeamCount(Number(e.target.value))} />
          </label>
          <button onClick={generateTeams}>팀 편성하기</button>
          <span style={{ opacity: 0.75 }}>
            참석 {activeCount}명 → 최대 {maxTeamsAllowed}팀 가능 (팀당 최소 5명)
          </span>
        </div>

        {balance && (
          <p style={{ marginTop: 10 }}>
            팀 점수 차이: <b>{balance.diff}</b> (max {balance.maxSum} / min {balance.minSum})
          </p>
        )}

        {teams && (
          <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {teams.map((t) => (
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
        )}
      </div>

      {/* GK 로테이션 */}
      <div style={{ marginTop: 18, border: "1px solid #eee", borderRadius: 10, padding: 12 }}>
        <h2>GK 로테이션</h2>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <label>
            경기 시간(분)&nbsp;
            <input type="number" value={matchMinutes} onChange={(e) => setMatchMinutes(Number(e.target.value))} />
          </label>
          <label>
            교대 단위(분)&nbsp;
            <input type="number" value={segmentMinutes} onChange={(e) => setSegmentMinutes(Number(e.target.value))} />
          </label>
          <button onClick={generateGK} disabled={!teams}>
            GK 스케줄 생성
          </button>
          {!teams && <span style={{ opacity: 0.7 }}>팀 편성 후에 생성할 수 있습니다.</span>}
        </div>

        {gkSchedules && (
          <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {gkSchedules.map((s) => (
              <div key={s.teamName} style={{ border: "1px solid #f0f0f0", borderRadius: 10, padding: 10 }}>
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

      <div style={{ marginTop: 16, opacity: 0.75, fontSize: 13 }}>
        ※ 저장은 현재 “이 브라우저(이 기기) 안에만” 됩니다. 팀원들과 기록을 공유하려면 다음 단계로 DB 저장 기능을 붙이면 됩니다.
      </div>
    </div>
  );
}
