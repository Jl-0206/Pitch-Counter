import { useState, useEffect, useRef } from "react";
import { db } from "./firebase";
import {
  collection, addDoc, getDocs, deleteDoc, doc, orderBy, query, setDoc, updateDoc
} from "firebase/firestore";

const PITCH_TYPES = [
  { id: "ball", label: "Ball", key: "B", color: "#22c55e", bg: "#14532d" },
  { id: "strike", label: "Strike", key: "S", color: "#ef4444", bg: "#7f1d1d" },
  { id: "in_play_hit", label: "In Play (Hit)", key: "H", color: "#f59e0b", bg: "#78350f" },
  { id: "foul", label: "Foul", key: "F", color: "#a78bfa", bg: "#3b0764" },
  { id: "swinging_strike", label: "Swing & Miss", key: "W", color: "#f97316", bg: "#7c2d12" },
  { id: "hbp", label: "Hit By Pitch", key: "P", color: "#06b6d4", bg: "#164e63" },
  { id: "foul_tip", label: "Foul Tip", key: "T", color: "#e879f9", bg: "#4a044e" },
  { id: "in_play_out", label: "In Play (Out)", key: "I", color: "#84cc16", bg: "#365314" },
  { id: "wild_pitch", label: "Wild Pitch", key: "X", color: "#fb923c", bg: "#431407" },
];

const ALL_EVENT_TYPES = [
  ...PITCH_TYPES,
  { id: "walk", label: "Walk", color: "#38bdf8", bg: "#0c4a6e" },
];

const PITCH_COLORS = {
  strike: "#ef4444", ball: "#22c55e", in_play_hit: "#f59e0b",
  in_play_out: "#84cc16", foul: "#a78bfa", swinging_strike: "#f97316",
  hbp: "#06b6d4", wild_pitch: "#fb923c", foul_tip: "#e879f9", walk: "#38bdf8",
};

const STRIKE_TYPES = new Set(["strike", "swinging_strike", "foul_tip", "foul"]);
const MAX_BALLS = 4;
const MAX_STRIKES = 3;

function calcStrikeStats(pitches) {
  const real = pitches.filter(p => !p.synthetic);
  let strikeCount = 0, strikePitches = 0;
  let currentStrikes = 0;
  for (const p of real) {
    const isFoul = p.type === "foul";
    const isStrike = STRIKE_TYPES.has(p.type);
    if (isFoul && currentStrikes >= 2) {
      // Foul at 2 strikes: counts as pitch but NOT a strike
    } else if (isStrike) {
      strikePitches++;
      if (p.type === "strike" || p.type === "swinging_strike" || p.type === "foul_tip") {
        currentStrikes = Math.min(currentStrikes + 1, MAX_STRIKES);
      } else if (isFoul) {
        currentStrikes = Math.min(currentStrikes + 1, MAX_STRIKES);
      }
    }
    // Reset strike count on at-bat ending events
    if (currentStrikes >= MAX_STRIKES || p.type === "in_play_hit" || p.type === "in_play_out" || p.type === "hbp" || p.type === "ball" || p.type === "wild_pitch") {
      if (p.type === "ball" || p.type === "wild_pitch") {
        // balls don't reset strike count
      } else {
        currentStrikes = 0;
      }
    }
    strikeCount = strikePitches;
  }
  return { strikes: strikePitches, total: real.length };
}

function calcStrikePct(pitches) {
  const { strikes, total } = calcStrikeStats(pitches);
  if (total === 0) return null;
  return Math.round((strikes / total) * 100);
}

function buildChartData(pitches) {
  const real = pitches.filter(p => !p.synthetic);
  let strikes = 0, currentStrikes = 0;
  return real.map((p, i) => {
    const isFoul = p.type === "foul";
    const isStrike = STRIKE_TYPES.has(p.type);
    if (isFoul && currentStrikes >= 2) {
      // foul at 2 strikes: doesn't count
    } else if (isStrike) {
      strikes++;
      if (p.type === "strike" || p.type === "swinging_strike" || p.type === "foul_tip" || isFoul) {
        currentStrikes = Math.min(currentStrikes + 1, MAX_STRIKES);
      }
    }
    if (currentStrikes >= MAX_STRIKES || p.type === "in_play_hit" || p.type === "in_play_out" || p.type === "hbp") {
      currentStrikes = 0;
    }
    return { pitch: i + 1, pct: Math.round((strikes / (i + 1)) * 100) };
  });
}

function buildGameChartData(sessions) {
  let offset = 0, totalStrikes = 0, totalPitches = 0;
  const series = [];
  for (const s of sessions) {
    const real = s.pitches.filter(p => !p.synthetic);
    let currentStrikes = 0;
    real.forEach((p, i) => {
      const isFoul = p.type === "foul";
      const isStrike = STRIKE_TYPES.has(p.type);
      if (isFoul && currentStrikes >= 2) {
        // foul at 2 strikes: doesn't count
      } else if (isStrike) {
        totalStrikes++;
        if (p.type === "strike" || p.type === "swinging_strike" || p.type === "foul_tip" || isFoul) {
          currentStrikes = Math.min(currentStrikes + 1, MAX_STRIKES);
        }
      }
      if (currentStrikes >= MAX_STRIKES || p.type === "in_play_hit" || p.type === "in_play_out" || p.type === "hbp") {
        currentStrikes = 0;
      }
      totalPitches++;
      series.push({ pitch: offset + i + 1, pct: Math.round((totalStrikes / totalPitches) * 100), pitcher: s.pitcher });
    });
    offset += real.length;
  }
  return series;
}

function StrikeChart({ data, sessions, height = 140 }) {
  const [tooltip, setTooltip] = useState(null);
  const svgRef = useRef(null);

  if (!data || data.length < 2) return (
    <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <span style={{ color: "#374e7e", fontSize: 12 }}>Record at least 2 pitches to see the trend</span>
    </div>
  );

  const W = 440, H = height;
  const PAD = { top: 12, right: 16, bottom: 28, left: 36 };
  const cw = W - PAD.left - PAD.right;
  const ch = H - PAD.top - PAD.bottom;
  const xScale = i => PAD.left + (i / (data.length - 1)) * cw;
  const yScale = v => PAD.top + ch - (v / 100) * ch;
  const points = data.map((d, i) => `${xScale(i)},${yScale(d.pct)}`).join(" ");
  const areaPoints = [`${xScale(0)},${yScale(0)}`, ...data.map((d, i) => `${xScale(i)},${yScale(d.pct)}`), `${xScale(data.length - 1)},${yScale(0)}`].join(" ");

  const boundaries = [];
  if (sessions && sessions.length > 1) {
    let count = 0;
    for (let i = 0; i < sessions.length - 1; i++) {
      count += sessions[i].pitches.filter(p => !p.synthetic).length;
      if (count < data.length) boundaries.push({ x: xScale(count - 1), pitcher: sessions[i + 1].pitcher });
    }
  }

  const handleMouseMove = (e) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = (e.clientX - rect.left) * (W / rect.width) - PAD.left;
    const idx = Math.max(0, Math.min(data.length - 1, Math.round((mx / cw) * (data.length - 1))));
    setTooltip({ idx, x: xScale(idx), y: yScale(data[idx].pct), d: data[idx] });
  };

  return (
    <div style={{ position: "relative" }}>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height, display: "block" }}
        onMouseMove={handleMouseMove} onMouseLeave={() => setTooltip(null)}
        onTouchMove={e => { e.preventDefault(); handleMouseMove(e.touches[0]); }} onTouchEnd={() => setTooltip(null)}>
        <defs>
          <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b6fde" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#3b6fde" stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id="lineGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#6366f1" /><stop offset="50%" stopColor="#3b6fde" /><stop offset="100%" stopColor="#38bdf8" />
          </linearGradient>
        </defs>
        {[0, 25, 50, 75, 100].map(v => (
          <g key={v}>
            <line x1={PAD.left} x2={PAD.left + cw} y1={yScale(v)} y2={yScale(v)} stroke={v === 50 ? "#2a4070" : "#1e2d4a"} strokeWidth={v === 50 ? 1.5 : 1} strokeDasharray={v === 50 ? "4 3" : "2 4"} />
            <text x={PAD.left - 6} y={yScale(v) + 4} textAnchor="end" fontSize="9" fill="#374e7e">{v}%</text>
          </g>
        ))}
        {boundaries.map((b, i) => (
          <g key={i}>
            <line x1={b.x} x2={b.x} y1={PAD.top} y2={PAD.top + ch} stroke="#3b6fde" strokeWidth={1.5} strokeDasharray="4 3" opacity={0.6} />
            <text x={b.x + 4} y={PAD.top + 10} fontSize="9" fill="#93c5fd">#{b.pitcher}</text>
          </g>
        ))}
        <polygon points={areaPoints} fill="url(#areaGrad)" />
        <polyline points={points} fill="none" stroke="url(#lineGrad)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        {data.map((d, i) => {
          if (data.length <= 20 || i % Math.ceil(data.length / 10) === 0 || i === data.length - 1)
            return <text key={i} x={xScale(i)} y={H - 6} textAnchor="middle" fontSize="9" fill="#374e7e">{d.pitch}</text>;
          return null;
        })}
        <text x={PAD.left + cw / 2} y={H} textAnchor="middle" fontSize="8" fill="#2a4070">Pitch #</text>
        {tooltip && (
          <g>
            <line x1={tooltip.x} x2={tooltip.x} y1={PAD.top} y2={PAD.top + ch} stroke="#93c5fd" strokeWidth={1} opacity={0.5} strokeDasharray="3 3" />
            <circle cx={tooltip.x} cy={tooltip.y} r={5} fill="#3b6fde" stroke="#93c5fd" strokeWidth={1.5} />
            <rect x={Math.min(tooltip.x + 8, W - 90)} y={tooltip.y - 22} width={80} height={22} rx={5} fill="#0d1525" stroke="#1e3a6e" />
            <text x={Math.min(tooltip.x + 48, W - 50)} y={tooltip.y - 7} textAnchor="middle" fontSize="10" fill="#93c5fd" fontWeight="bold">P{tooltip.d.pitch}: {tooltip.d.pct}%</text>
          </g>
        )}
      </svg>
    </div>
  );
}

function CountDot({ filled, color }) {
  return <div style={{ width: 18, height: 18, borderRadius: "50%", background: filled ? color : "transparent", border: `2px solid ${filled ? color : "#4b5563"}`, boxShadow: filled ? `0 0 8px ${color}88` : "none", transition: "all 0.2s ease" }} />;
}

function PitchDot({ pitch, index }) {
  const color = PITCH_COLORS[pitch.type] || "#9ca3af";
  const isWalk = pitch.type === "walk";
  return (
    <div title={`${index + 1}. ${ALL_EVENT_TYPES.find(p => p.id === pitch.type)?.label || pitch.type}`}
      style={{ width: isWalk ? 20 : 14, height: isWalk ? 20 : 14, borderRadius: isWalk ? 4 : "50%", background: color, boxShadow: `0 0 ${isWalk ? 10 : 6}px ${color}${isWalk ? "cc" : "99"}`, cursor: "default", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: isWalk ? 11 : 0, color: "#fff", fontWeight: "bold" }}>
      {isWalk ? "W" : ""}
    </div>
  );
}

function StrikePctBar({ pct }) {
  const color = pct >= 60 ? "#22c55e" : pct >= 45 ? "#f59e0b" : "#ef4444";
  return (
    <div style={{ width: "100%", marginTop: 6 }}>
      <div style={{ height: 6, background: "#1e293b", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 3, transition: "width 0.4s ease", boxShadow: `0 0 6px ${color}88` }} />
      </div>
    </div>
  );
}

export default function App() {
  const [screen, setScreen] = useState("home");
  const [savedGames, setSavedGames] = useState([]);
  const [storageReady, setStorageReady] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const todayStr = new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
  const [gameLabel, setGameLabel] = useState("");
  const [gameDate, setGameDate] = useState(new Date().toISOString().slice(0, 10));
  const [balls, setBalls] = useState(0);
  const [strikes, setStrikes] = useState(0);
  const [pitches, setPitches] = useState([]);
  const [lastAction, setLastAction] = useState(null);
  const [flash, setFlash] = useState(null);
  const [pitcherNumber, setPitcherNumber] = useState("");
  const [sessions, setSessions] = useState([]);

  const [showExport, setShowExport] = useState(false);
  const [copied, setCopied] = useState(false);
  const [viewGame, setViewGame] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [activeGameId, setActiveGameId] = useState(null);
  const [autoSaveStatus, setAutoSaveStatus] = useState(null); // "saving" | "saved" | "error"

  // Derive smart default game label from saved games
  const getDefaultLabel = (games) => {
    const today = new Date().toISOString().slice(0, 10);
    const todayGames = games.filter(g => g.date === today);
    const num = todayGames.length + 1;
    const formatted = new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
    return `${formatted} - Game ${num}`;
  };

  // Load games from Firestore on mount
  useEffect(() => {
    (async () => {
      try {
        const q = query(collection(db, "games"), orderBy("savedAt", "desc"));
        const snapshot = await getDocs(q);
        const games = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        setSavedGames(games);
        setGameLabel(getDefaultLabel(games));
      } catch (e) {
        setSaveError("Could not connect to database. Check your Firebase config.");
        console.error(e);
      }
      setStorageReady(true);
    })();
  }, []);

  useEffect(() => {
    if (balls >= MAX_BALLS) {
      setPitches(prev => {
        const last = prev[prev.length - 1];
        if (last && last.type === "walk") return prev;
        return [...prev, { type: "walk", timestamp: Date.now(), pitcher: pitcherNumber || "—", synthetic: true }];
      });
      const t = setTimeout(() => { setBalls(0); setStrikes(0); }, 1200);
      return () => clearTimeout(t);
    }
    if (strikes >= MAX_STRIKES) {
      const t = setTimeout(() => { setBalls(0); setStrikes(0); }, 1200);
      return () => clearTimeout(t);
    }
  }, [balls, strikes]);

  const triggerFlash = (id) => { setFlash(id); setTimeout(() => setFlash(null), 300); };

  const recordPitch = (type) => {
    const pitch = { type, timestamp: Date.now(), pitcher: pitcherNumber || "—" };
    if (type === "hbp") {
      const hbpPitches = [...pitches, pitch, { type: "walk", timestamp: Date.now() + 1, pitcher: pitcherNumber || "—", synthetic: true }];
      setPitches(hbpPitches);
      setLastAction(type); triggerFlash(type);
      setTimeout(() => { setBalls(0); setStrikes(0); }, 1200);
      autoSave(sessions, hbpPitches, pitcherNumber, gameLabel, gameDate);
      return;
    }
    const newPitches = [...pitches, pitch];
    setPitches(newPitches);
    setLastAction(type); triggerFlash(type);
    if (type === "in_play_hit" || type === "in_play_out") { setBalls(0); setStrikes(0); }
    else if (type === "ball" || type === "wild_pitch") setBalls(prev => Math.min(prev + 1, MAX_BALLS));
    else if (type === "strike" || type === "swinging_strike" || type === "foul_tip") setStrikes(prev => Math.min(prev + 1, MAX_STRIKES));
    else if (type === "foul") setStrikes(prev => (prev < 2 ? prev + 1 : prev));
    // Auto-save after every pitch
    autoSave(sessions, newPitches, pitcherNumber, gameLabel, gameDate);
  };

  const resetCount = () => { setBalls(0); setStrikes(0); setLastAction("reset"); };

  const undoLast = () => {
    if (pitches.length === 0) return;

    // Strip trailing synthetic events (e.g. auto-walk from useEffect)
    let prev = [...pitches];
    while (prev.length > 0 && prev[prev.length - 1].synthetic) {
      prev = prev.slice(0, -1);
    }
    // Remove the last real pitch
    if (prev.length > 0) prev = prev.slice(0, -1);
    // Strip any newly exposed trailing synthetics
    while (prev.length > 0 && prev[prev.length - 1].synthetic) {
      prev = prev.slice(0, -1);
    }

    // Recalculate balls & strikes from scratch
    let b = 0, s = 0;
    for (const p of prev) {
      if (p.synthetic) continue;
      if (p.type === "in_play_hit" || p.type === "in_play_out" || p.type === "hbp") {
        b = 0; s = 0;
      } else if (p.type === "ball" || p.type === "wild_pitch") {
        b = Math.min(b + 1, MAX_BALLS);
      } else if (p.type === "strike" || p.type === "swinging_strike" || p.type === "foul_tip") {
        s = Math.min(s + 1, MAX_STRIKES);
      } else if (p.type === "foul") {
        s = s < 2 ? s + 1 : s;
      }
    }

    setBalls(b);
    setStrikes(s);
    setPitches(prev);
    const lastReal = [...prev].reverse().find(p => !p.synthetic);
    setLastAction(lastReal ? lastReal.type : null);
  };

  // Auto-save current game state to Firestore
  const autoSave = async (currentSessions, currentPitches, currentPitcherNumber, currentLabel, currentDate) => {
    const allSessions = currentPitches.length > 0
      ? [...currentSessions, { pitcher: currentPitcherNumber || "—", pitchCount: currentPitches.filter(p => !p.synthetic).length, strikePct: calcStrikePct(currentPitches), pitches: [...currentPitches] }]
      : currentSessions;
    if (allSessions.length === 0) return;
    const gameData = { label: currentLabel || "Untitled Game", date: currentDate, sessions: allSessions, savedAt: new Date().toISOString() };
    setAutoSaveStatus("saving");
    try {
      if (activeGameId) {
        await updateDoc(doc(db, "games", activeGameId), gameData);
        setSavedGames(prev => prev.map(g => g.id === activeGameId ? { id: activeGameId, ...gameData } : g));
      } else {
        const docRef = await addDoc(collection(db, "games"), gameData);
        setActiveGameId(docRef.id);
        setSavedGames(prev => [{ id: docRef.id, ...gameData }, ...prev]);
      }
      setAutoSaveStatus("saved");
      setTimeout(() => setAutoSaveStatus(null), 2000);
    } catch (e) {
      console.error(e);
      setAutoSaveStatus("error");
      setTimeout(() => setAutoSaveStatus(null), 3000);
    }
  };

  const changePitcher = () => {
    const newSession = pitches.length > 0
      ? { pitcher: pitcherNumber || "—", pitchCount: pitches.filter(p => !p.synthetic).length, strikePct: calcStrikePct(pitches), pitches: [...pitches] }
      : null;
    const newSessions = newSession ? [...sessions, newSession] : sessions;
    if (newSession) setSessions(newSessions);
    autoSave(newSessions, [], "", gameLabel, gameDate);
    setPitches([]); setBalls(0); setStrikes(0); setLastAction(null); setPitcherNumber("");
  };

  const finishGame = async () => {
    await autoSave(sessions, pitches, pitcherNumber, gameLabel, gameDate);
    setActiveGameId(null);
    setSessions([]); setPitches([]); setBalls(0); setStrikes(0);
    setPitcherNumber(""); setLastAction(null);
    setScreen("home");
    // Reset label for next game
    setSavedGames(prev => {
      setGameLabel(getDefaultLabel(prev));
      return prev;
    });
    setGameDate(new Date().toISOString().slice(0, 10));
  };

  const deleteGame = async (id) => {
    try { await deleteDoc(doc(db, "games", id)); } catch (e) { console.error(e); }
    setSavedGames(prev => prev.filter(g => g.id !== id));
    setDeleteConfirm(null);
    if (viewGame && viewGame.id === id) { setViewGame(null); setScreen("home"); }
  };

  const buildCSV = (game) => {
    const lines = [`GAME: ${game.label}`, `DATE: ${game.date}`, "", "PITCHER SUMMARY", "Pitcher #,Total Pitches,Strike %"];
    for (const s of game.sessions) lines.push(`${s.pitcher},${s.pitchCount},${s.strikePct !== null ? s.strikePct + "%" : "—"}`);
    lines.push("", "PITCH LOG", "Session,Pitcher #,Pitch #,Event,Time");
    game.sessions.forEach((s, si) => {
      let pn = 1;
      for (const p of s.pitches) {
        lines.push([si + 1, s.pitcher, pn, ALL_EVENT_TYPES.find(t => t.id === p.type)?.label || p.type, new Date(p.timestamp).toLocaleTimeString()].join(","));
        if (!p.synthetic) pn++;
      }
    });
    return lines.join("\n");
  };

  const currentStrikePct = calcStrikePct(pitches);
  const realPitchCount = pitches.filter(p => !p.synthetic).length;
  const isWalk = balls >= MAX_BALLS;
  const isStrikeout = strikes >= MAX_STRIKES;
  const lastPitchLabel = lastAction && lastAction !== "reset" ? ALL_EVENT_TYPES.find(p => p.id === lastAction)?.label : null;
  const liveChartSessions = pitches.length > 0 ? [...sessions, { pitcher: pitcherNumber || "—", pitchCount: realPitchCount, strikePct: currentStrikePct, pitches }] : sessions;
  const liveChartData = buildGameChartData(liveChartSessions);

  const cardStyle = { background: "linear-gradient(135deg, #111827 0%, #1a2744 100%)", border: "1px solid #1e3a6e", borderRadius: 12, padding: "14px 20px", marginBottom: 14 };
  const bgStyle = { minHeight: "100vh", background: "#0a0f1e", fontFamily: "'Georgia', serif", padding: "24px 16px", position: "relative" };

  // ── HOME ─────────────────────────────────────────────────────────────────────
  if (screen === "home") return (
    <div style={bgStyle}>
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse at 50% 0%, #0f2340 0%, #0a0f1e 70%)", pointerEvents: "none" }} />
      <div style={{ position: "relative", zIndex: 1, maxWidth: 480, margin: "0 auto" }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ fontSize: 11, letterSpacing: "0.4em", color: "#4b6a9e", textTransform: "uppercase", marginBottom: 6 }}>Baseball</div>
          <h1 style={{ margin: 0, fontSize: 30, fontWeight: "bold", color: "#e8eaf6", letterSpacing: "0.05em", textTransform: "uppercase" }}>Pitch Counter</h1>
          <div style={{ width: 60, height: 2, background: "linear-gradient(90deg, transparent, #3b6fde, transparent)", margin: "10px auto 0" }} />
        </div>
        {saveError && <div style={{ background: "#1a0a0a", border: "1px solid #7f1d1d", borderRadius: 10, padding: "12px 16px", marginBottom: 16, color: "#fca5a5", fontSize: 13 }}>⚠️ {saveError}</div>}
        <div style={{ ...cardStyle, marginBottom: 20 }}>
          <div style={{ fontSize: 10, letterSpacing: "0.35em", color: "#4b6a9e", textTransform: "uppercase", marginBottom: 14 }}>New Game</div>
          <input placeholder="vs. Team Name (e.g. vs. Cardinals)" value={gameLabel} onChange={e => setGameLabel(e.target.value)} style={{ width: "100%", boxSizing: "border-box", background: "#0d1525", border: "1px solid #1e3a6e", borderRadius: 8, padding: "10px 14px", color: "#e8eaf6", fontSize: 14, fontFamily: "'Georgia', serif", outline: "none", marginBottom: 10 }} />
          <input type="date" value={gameDate} onChange={e => setGameDate(e.target.value)} style={{ width: "100%", boxSizing: "border-box", background: "#0d1525", border: "1px solid #1e3a6e", borderRadius: 8, padding: "10px 14px", color: "#e8eaf6", fontSize: 14, fontFamily: "'Georgia', serif", outline: "none", marginBottom: 14, colorScheme: "dark" }} />
          <button onClick={() => setScreen("game")} style={{ width: "100%", background: "linear-gradient(135deg, #1a3a6e, #0f2340)", border: "1px solid #3b6fde", borderRadius: 10, padding: "13px", color: "#93c5fd", fontSize: 15, fontWeight: "bold", cursor: "pointer", letterSpacing: "0.15em", textTransform: "uppercase", fontFamily: "'Georgia', serif" }}>⚾ Start Game</button>
        </div>
        {!storageReady && <div style={{ textAlign: "center", color: "#374e7e", fontSize: 13 }}>Loading games...</div>}
        {storageReady && savedGames.length > 0 && (
          <div>
            <div style={{ fontSize: 10, letterSpacing: "0.35em", color: "#374e7e", textTransform: "uppercase", marginBottom: 12 }}>Game History</div>
            {savedGames.map(game => (
              <div key={game.id} style={{ background: "#111827", border: "1px solid #1e3a6e", borderRadius: 12, padding: "14px 18px", marginBottom: 10, cursor: "pointer" }} onClick={() => { setViewGame(game); setScreen("history"); }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <div style={{ color: "#e8eaf6", fontWeight: "bold", fontSize: 15, marginBottom: 3 }}>{game.label}</div>
                    <div style={{ color: "#4b6a9e", fontSize: 12 }}>{game.date} · {game.sessions.length} pitcher{game.sessions.length !== 1 ? "s" : ""}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    {game.sessions.map((s, i) => (
                      <div key={i} style={{ fontSize: 12, color: s.strikePct >= 60 ? "#22c55e" : s.strikePct >= 45 ? "#f59e0b" : "#ef4444" }}>#{s.pitcher}: {s.strikePct !== null ? `${s.strikePct}%` : "—"}</div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        {storageReady && savedGames.length === 0 && <div style={{ textAlign: "center", color: "#374e7e", fontSize: 13, padding: "20px 0" }}>No saved games yet. Start a new game above!</div>}
      </div>
    </div>
  );

  // ── HISTORY ──────────────────────────────────────────────────────────────────
  if (screen === "history" && viewGame) {
    const gameChartData = buildGameChartData(viewGame.sessions);
    return (
      <div style={bgStyle}>
        <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse at 50% 0%, #0f2340 0%, #0a0f1e 70%)", pointerEvents: "none" }} />
        <div style={{ position: "relative", zIndex: 1, maxWidth: 480, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 22 }}>
            <button onClick={() => setScreen("home")} style={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8, padding: "8px 14px", color: "#94a3b8", fontSize: 13, cursor: "pointer", fontFamily: "'Georgia', serif" }}>← Back</button>
            <div>
              <div style={{ color: "#e8eaf6", fontWeight: "bold", fontSize: 18 }}>{viewGame.label}</div>
              <div style={{ color: "#4b6a9e", fontSize: 12 }}>{viewGame.date}</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, marginBottom: 18 }}>
            <button onClick={() => setShowExport(true)} style={{ flex: 1, background: "linear-gradient(135deg, #1a3a6e, #0f2340)", border: "1px solid #3b6fde", borderRadius: 10, padding: "11px", color: "#93c5fd", fontSize: 13, fontWeight: "bold", cursor: "pointer", letterSpacing: "0.1em", textTransform: "uppercase", fontFamily: "'Georgia', serif" }}>⬇ Export</button>
            <button onClick={() => setDeleteConfirm(viewGame.id)} style={{ background: "#1e293b", border: "1px solid #7f1d1d", borderRadius: 10, padding: "11px 18px", color: "#ef4444", fontSize: 13, cursor: "pointer", fontFamily: "'Georgia', serif" }}>🗑 Delete</button>
          </div>
          {deleteConfirm === viewGame.id && (
            <div style={{ background: "#1a0a0a", border: "1px solid #7f1d1d", borderRadius: 10, padding: "14px 18px", marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ color: "#fca5a5", fontSize: 13 }}>Delete this game?</span>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => deleteGame(viewGame.id)} style={{ background: "#7f1d1d", border: "none", borderRadius: 6, padding: "6px 14px", color: "#fca5a5", cursor: "pointer", fontFamily: "'Georgia', serif" }}>Delete</button>
                <button onClick={() => setDeleteConfirm(null)} style={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 6, padding: "6px 14px", color: "#94a3b8", cursor: "pointer", fontFamily: "'Georgia', serif" }}>Cancel</button>
              </div>
            </div>
          )}
          {gameChartData.length >= 2 && (
            <div style={cardStyle}>
              <div style={{ fontSize: 10, letterSpacing: "0.35em", color: "#4b6a9e", textTransform: "uppercase", marginBottom: 10 }}>Strike % Trend — Full Game</div>
              <StrikeChart data={gameChartData} sessions={viewGame.sessions} height={150} />
            </div>
          )}
          {viewGame.sessions.map((s, i) => {
            const pitcherData = buildChartData(s.pitches);
            return (
              <div key={i} style={{ background: "#111827", border: "1px solid #1e3a6e", borderRadius: 12, padding: "16px 20px", marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <span style={{ color: "#93c5fd", fontWeight: "bold", fontSize: 17 }}>Pitcher #{s.pitcher}</span>
                  <span style={{ fontSize: 22, fontWeight: "bold", color: s.strikePct >= 60 ? "#22c55e" : s.strikePct >= 45 ? "#f59e0b" : "#ef4444" }}>{s.strikePct !== null ? `${s.strikePct}%` : "—"}</span>
                </div>
                {s.strikePct !== null && <StrikePctBar pct={s.strikePct} />}
                <div style={{ fontSize: 11, color: "#6b7280", marginTop: 6, marginBottom: 12 }}>{s.pitchCount} total pitches</div>
                {pitcherData.length >= 2 && <div style={{ marginBottom: 12, background: "#0d1525", borderRadius: 8, padding: "10px 8px" }}><StrikeChart data={pitcherData} height={120} /></div>}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 10 }}>
                  {s.pitches.map((p, pi) => <PitchDot key={pi} pitch={p} index={pi} />)}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {ALL_EVENT_TYPES.map(et => {
                    const count = s.pitches.filter(x => x.type === et.id).length;
                    if (!count) return null;
                    return <span key={et.id} style={{ fontSize: 11, color: et.color, background: et.color + "15", border: `1px solid ${et.color}33`, borderRadius: 20, padding: "2px 8px" }}>{et.label}: {count}</span>;
                  })}
                </div>
              </div>
            );
          })}
          {showExport && (
            <div style={{ position: "fixed", inset: 0, background: "#000000cc", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
              <div style={{ background: "#111827", border: "1px solid #1e3a6e", borderRadius: 16, padding: 24, width: "100%", maxWidth: 460, maxHeight: "80vh", display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ fontSize: 13, letterSpacing: "0.2em", color: "#93c5fd", textTransform: "uppercase", fontWeight: "bold" }}>CSV Data</div>
                  <button onClick={() => setShowExport(false)} style={{ background: "none", border: "none", color: "#6b7280", fontSize: 20, cursor: "pointer" }}>✕</button>
                </div>
                <p style={{ margin: 0, fontSize: 12, color: "#6b7280", lineHeight: 1.5 }}>Copy and paste into Google Sheets or Excel.</p>
                <textarea readOnly value={buildCSV(viewGame)} style={{ flex: 1, minHeight: 220, background: "#0d1525", border: "1px solid #1e3a6e", borderRadius: 8, color: "#cbd5e1", fontSize: 11, padding: 12, fontFamily: "monospace", resize: "none", outline: "none", lineHeight: 1.6 }} />
                <button onClick={() => { navigator.clipboard.writeText(buildCSV(viewGame)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }); }} style={{ background: copied ? "#14532d" : "linear-gradient(135deg, #1a3a6e, #0f2340)", border: `1px solid ${copied ? "#22c55e" : "#3b6fde"}`, borderRadius: 10, padding: "13px", color: copied ? "#86efac" : "#93c5fd", fontSize: 14, fontWeight: "bold", cursor: "pointer", letterSpacing: "0.15em", textTransform: "uppercase", fontFamily: "'Georgia', serif" }}>
                  {copied ? "✓ Copied!" : "Copy to Clipboard"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── GAME SCREEN ──────────────────────────────────────────────────────────────
  return (
    <div style={{ ...bgStyle, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse at 50% 0%, #0f2340 0%, #0a0f1e 70%)", pointerEvents: "none" }} />
      <div style={{ position: "absolute", inset: 0, opacity: 0.03, backgroundImage: "repeating-linear-gradient(0deg, #fff 0px, #fff 1px, transparent 1px, transparent 40px), repeating-linear-gradient(90deg, #fff 0px, #fff 1px, transparent 1px, transparent 40px)", pointerEvents: "none" }} />
      <div style={{ position: "relative", zIndex: 1, width: "100%", maxWidth: 480 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <button onClick={() => setScreen("home")} style={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8, padding: "8px 14px", color: "#94a3b8", fontSize: 13, cursor: "pointer", fontFamily: "'Georgia', serif" }}>← Home</button>
          <div style={{ textAlign: "center" }}>
            <div style={{ color: "#e8eaf6", fontWeight: "bold", fontSize: 15 }}>{gameLabel || "New Game"}</div>
            <div style={{ color: "#4b6a9e", fontSize: 11 }}>{gameDate}</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
            <button onClick={finishGame} style={{ background: "linear-gradient(135deg, #14532d, #0f2340)", border: "1px solid #22c55e", borderRadius: 8, padding: "8px 14px", color: "#86efac", fontSize: 13, fontWeight: "bold", cursor: "pointer", fontFamily: "'Georgia', serif" }}>✓ Finish</button>
            {autoSaveStatus === "saving" && <span style={{ fontSize: 10, color: "#4b6a9e" }}>saving...</span>}
            {autoSaveStatus === "saved" && <span style={{ fontSize: 10, color: "#22c55e" }}>✓ saved</span>}
            {autoSaveStatus === "error" && <span style={{ fontSize: 10, color: "#ef4444" }}>save error</span>}
          </div>
        </div>

        <div style={{ ...cardStyle, display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ fontSize: 11, letterSpacing: "0.3em", color: "#4b6a9e", textTransform: "uppercase", whiteSpace: "nowrap" }}>Pitcher #</div>
          <input type="number" min="0" max="99" value={pitcherNumber} onChange={e => setPitcherNumber(e.target.value)} placeholder="—" style={{ flex: 1, background: "#0d1525", border: "1px solid #1e3a6e", borderRadius: 8, padding: "8px 14px", color: "#e8eaf6", fontSize: 22, fontWeight: "bold", fontFamily: "'Georgia', serif", outline: "none", textAlign: "center", appearance: "textfield", MozAppearance: "textfield", WebkitAppearance: "none" }} />
          <button onClick={changePitcher} style={{ background: "#1a2744", border: "1px solid #3b6fde", borderRadius: 8, padding: "9px 14px", color: "#93c5fd", fontSize: 12, fontWeight: "bold", cursor: "pointer", letterSpacing: "0.08em", textTransform: "uppercase", fontFamily: "'Georgia', serif", whiteSpace: "nowrap" }}>🔄 Change</button>
        </div>
        {realPitchCount > 0 && (
          <div style={cardStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: 11, letterSpacing: "0.3em", color: "#4b6a9e", textTransform: "uppercase" }}>Strike %{pitcherNumber ? ` — #${pitcherNumber}` : ""}</div>
              <div style={{ fontSize: 26, fontWeight: "bold", color: currentStrikePct >= 60 ? "#22c55e" : currentStrikePct >= 45 ? "#f59e0b" : "#ef4444" }}>{currentStrikePct}%</div>
            </div>
            <StrikePctBar pct={currentStrikePct} />
            <div style={{ fontSize: 10, color: "#374e7e", marginTop: 6, textAlign: "right" }}>{pitches.filter(p => !p.synthetic && STRIKE_TYPES.has(p.type)).length} strikes / {realPitchCount} pitches</div>
          </div>
        )}
        {liveChartData.length >= 2 && (
          <div style={cardStyle}>
            <div style={{ fontSize: 10, letterSpacing: "0.35em", color: "#4b6a9e", textTransform: "uppercase", marginBottom: 8 }}>Strike % Trend</div>
            <StrikeChart data={liveChartData} sessions={liveChartSessions} height={140} />
          </div>
        )}
        <div style={{ ...cardStyle, boxShadow: "0 4px 32px #00000066" }}>
          <div style={{ display: "flex", justifyContent: "space-around", alignItems: "center" }}>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 11, letterSpacing: "0.3em", color: "#4b8b5e", textTransform: "uppercase", marginBottom: 10 }}>Balls</div>
              <div style={{ fontSize: 56, fontWeight: "bold", color: "#22c55e", lineHeight: 1 }}>{balls}</div>
              <div style={{ display: "flex", gap: 5, justifyContent: "center", marginTop: 10 }}>
                {Array.from({ length: MAX_BALLS }).map((_, i) => <CountDot key={i} filled={i < balls} color="#22c55e" />)}
              </div>
            </div>
            <div style={{ fontSize: 40, color: "#1e3a6e", fontWeight: "100" }}>–</div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 11, letterSpacing: "0.3em", color: "#8b2020", textTransform: "uppercase", marginBottom: 10 }}>Strikes</div>
              <div style={{ fontSize: 56, fontWeight: "bold", color: "#ef4444", lineHeight: 1 }}>{strikes}</div>
              <div style={{ display: "flex", gap: 5, justifyContent: "center", marginTop: 10 }}>
                {Array.from({ length: MAX_STRIKES }).map((_, i) => <CountDot key={i} filled={i < strikes} color="#ef4444" />)}
              </div>
            </div>
          </div>
          {(isWalk || isStrikeout) && (
            <div style={{ marginTop: 18, padding: "10px 16px", borderRadius: 8, background: isWalk ? "#0c4a6e44" : "#7f1d1d44", border: `1px solid ${isWalk ? "#38bdf844" : "#ef444444"}`, textAlign: "center", fontSize: 14, letterSpacing: "0.15em", color: isWalk ? "#7dd3fc" : "#fca5a5", textTransform: "uppercase", fontWeight: "bold" }}>
              {isWalk ? "⚾ Walk!" : "🔥 Strikeout!"}
            </div>
          )}
          <div style={{ textAlign: "center", marginTop: 14 }}>
            <span style={{ fontSize: 12, color: "#374e7e", letterSpacing: "0.2em", textTransform: "uppercase" }}>Pitch {realPitchCount}</span>
            {lastPitchLabel && <span style={{ marginLeft: 10, fontSize: 12, color: "#6b7280" }}>· Last: <span style={{ color: "#9ca3af" }}>{lastPitchLabel}</span></span>}
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
          {PITCH_TYPES.map(p => (
            <button key={p.id} onClick={() => recordPitch(p.id)} style={{ background: flash === p.id ? p.color + "33" : `${p.bg}88`, border: `1px solid ${flash === p.id ? p.color : p.color + "44"}`, borderRadius: 10, padding: "14px 10px", cursor: "pointer", color: p.color, fontSize: 15, fontWeight: "bold", letterSpacing: "0.04em", textTransform: "uppercase", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, transition: "all 0.15s ease", transform: flash === p.id ? "scale(0.97)" : "scale(1)", boxShadow: flash === p.id ? `0 0 16px ${p.color}44` : "none", fontFamily: "'Georgia', serif" }}>
              <span style={{ fontSize: 11, opacity: 0.5, fontWeight: "normal", background: p.color + "22", border: `1px solid ${p.color}44`, borderRadius: 4, padding: "1px 5px" }}>{p.key}</span>
              {p.label}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
          <button onClick={undoLast} disabled={pitches.length === 0} style={{ flex: 1, background: "#1e293b", border: "1px solid #334155", borderRadius: 8, padding: "11px", color: pitches.length === 0 ? "#374151" : "#94a3b8", fontSize: 13, cursor: pitches.length === 0 ? "not-allowed" : "pointer", letterSpacing: "0.1em", textTransform: "uppercase", fontFamily: "'Georgia', serif" }}>↩ Undo</button>
          <button onClick={resetCount} style={{ flex: 1, background: "#1e293b", border: "1px solid #334155", borderRadius: 8, padding: "11px", color: "#94a3b8", fontSize: 13, cursor: "pointer", letterSpacing: "0.1em", textTransform: "uppercase", fontFamily: "'Georgia', serif" }}>Reset Count</button>

        </div>
        {sessions.length > 0 && (
          <div style={{ background: "#111827", border: "1px solid #1e3a6e", borderRadius: 12, padding: "16px 20px", marginBottom: 14 }}>
            <div style={{ fontSize: 10, letterSpacing: "0.35em", color: "#374e7e", textTransform: "uppercase", marginBottom: 12 }}>Pitchers This Game</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {sessions.map((s, i) => (
                <div key={i} style={{ background: "#0d1525", borderRadius: 8, padding: "10px 14px", border: "1px solid #1e3a6e" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                    <span style={{ color: "#93c5fd", fontWeight: "bold", fontSize: 15 }}>#{s.pitcher}</span>
                    <span style={{ fontSize: 11, color: "#6b7280" }}>{s.pitchCount} pitches</span>
                    <span style={{ fontSize: 18, fontWeight: "bold", color: s.strikePct >= 60 ? "#22c55e" : s.strikePct >= 45 ? "#f59e0b" : "#ef4444" }}>{s.strikePct !== null ? `${s.strikePct}%` : "—"}</span>
                  </div>
                  {s.strikePct !== null && <StrikePctBar pct={s.strikePct} />}
                </div>
              ))}
            </div>
          </div>
        )}
        {pitches.length > 0 && (
          <div style={{ background: "#111827", border: "1px solid #1e3a6e", borderRadius: 12, padding: "16px 20px" }}>
            <div style={{ fontSize: 10, letterSpacing: "0.35em", color: "#374e7e", textTransform: "uppercase", marginBottom: 14 }}>Pitch Sequence</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "flex-end" }}>
              {pitches.map((p, i) => (
                <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
                  <PitchDot pitch={p} index={i} />
                  <span style={{ fontSize: 9, color: p.type === "walk" ? "#38bdf8" : "#374e7e" }}>{i + 1}</span>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 8 }}>
              {ALL_EVENT_TYPES.map(p => {
                const count = pitches.filter(x => x.type === p.id).length;
                if (!count) return null;
                return <span key={p.id} style={{ fontSize: 11, color: p.color, background: p.color + "15", border: `1px solid ${p.color}33`, borderRadius: 20, padding: "3px 9px" }}>{p.label}: {count}</span>;
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
