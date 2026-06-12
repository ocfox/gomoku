import "./styles.css";
import PartySocket from "partysocket";
import { tiks } from "@rexa-developer/tiks";

tiks.init({ theme: "arcade" });

type Phase = "waiting" | "ready" | "playing" | "ended";
type Role = "p1" | "p2" | "spectator";

interface State {
  board: number[][];
  phase: Phase;
  turn: 1 | 2;
  winner: 1 | 2 | "draw" | null;
  ready: { p1: boolean; p2: boolean };
  scores: { p1: number; p2: number };
  lastMove: { x: number; y: number } | null;
  yourRole: Role;
  blackPlayer: 1 | 2;
  secret?: string;
}

// 5 star points: center + 4 corner stars (0-indexed on 15x15)
const STARS = new Set(
  [
    [3, 3],
    [3, 11],
    [7, 7],
    [11, 3],
    [11, 11],
  ].map(([x, y]) => `${x},${y}`),
);

const params = new URLSearchParams(location.search);
let roomId = params.get("room");
if (!roomId) {
  roomId = String(Math.floor(1000 + Math.random() * 9000));
  params.set("room", roomId);
  history.replaceState(null, "", "?" + params.toString());
}

const SECRET_KEY = `secret-${roomId}`;

const socket = new PartySocket({
  host: location.host,
  room: roomId,
  party: "gomoku-room",
});
let state: State | null = null;
let myRole: Role = "spectator";
let waitingRematch = false;
let pendingMove: { x: number; y: number } | null = null;

let prevTurn: number | null = null;
let prevPhase: Phase | null = null;
let turnStartTime = 0;
let timerInterval: ReturnType<typeof setInterval> | null = null;

socket.addEventListener("open", () => {
  socket.send(
    JSON.stringify({
      type: "join",
      secret: localStorage.getItem(SECRET_KEY),
    }),
  );
});

socket.addEventListener("message", (e: MessageEvent) => {
  const msg: State & { type: string } = JSON.parse(e.data);
  if (msg.type !== "state") return;

  if (msg.secret) {
    localStorage.setItem(SECRET_KEY, msg.secret);
  }

  myRole = msg.yourRole;

  if (msg.phase === "playing") {
    if (msg.turn !== prevTurn || prevPhase !== "playing") {
      if (prevPhase !== "playing") waitingRematch = false;
      prevTurn = msg.turn;
      turnStartTime = Date.now();
      if (!timerInterval) timerInterval = setInterval(tickTimer, 1000);
    }
  } else {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    prevTurn = null;
  }

  prevPhase = msg.phase;
  pendingMove = null;
  state = msg;
  render();
});

function tickTimer() {
  const el = document.getElementById("timer");
  if (el) el.textContent = elapsed();
}

function elapsed(): string {
  const s = Math.floor((Date.now() - turnStartTime) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Returns which stone color the local player is using this round
function myColor(s: State): "black" | "white" | null {
  if (myRole === "spectator") return null;
  return (myRole === "p1") === (s.blackPlayer === 1) ? "black" : "white";
}

function isMyTurn(s: State): boolean {
  if (myRole === "spectator" || s.phase !== "playing") return false;
  if (pendingMove !== null) return false;
  return (myRole === "p1" && s.turn === 1) || (myRole === "p2" && s.turn === 2);
}

function render() {
  if (!state) return;
  document.getElementById("app")!.innerHTML = buildHTML(state);
  bindEvents();
}

function buildHTML(s: State): string {
  const timer =
    s.phase === "playing" ? `<span id="timer">${elapsed()}</span>` : "";

  // Display scores as ●/○ based on who is black this round
  const p1IsBlack = s.blackPlayer === 1;
  const blackScore = p1IsBlack ? s.scores.p1 : s.scores.p2;
  const whiteScore = p1IsBlack ? s.scores.p2 : s.scores.p1;
  const iAmBlack = myColor(s) === "black";
  const iAmWhite = myColor(s) === "white";

  return `
    <div class="game">
      <div class="board-meta">
        <span class="status">${statusText(s)}</span>
        <span class="right-meta">
          ${timer}
          <span class="scores">
            <span class="score-b ${iAmBlack ? "you" : ""}">● ${blackScore}</span>
            <span class="score-w ${iAmWhite ? "you" : ""}">○ ${whiteScore}</span>
          </span>
        </span>
      </div>
      <div class="board-wrap">
        ${buildBoard(s)}
        ${buildOverlay(s)}
      </div>
    </div>
  `;
}

function statusText(s: State): string {
  if (s.phase === "waiting") return "Waiting for opponent…";
  if (s.phase === "ready") {
    if (myRole === "spectator") return "Waiting for players";
    const iReady = s.ready[myRole as "p1" | "p2"];
    return iReady ? "Waiting for opponent…" : "";
  }
  if (s.phase === "playing") {
    if (myRole === "spectator") {
      const turnIsBlack =
        (s.turn === 1 && s.blackPlayer === 1) ||
        (s.turn === 2 && s.blackPlayer === 2);
      return turnIsBlack ? "Black's turn" : "White's turn";
    }
    return isMyTurn(s) ? "Your turn" : "Waiting for opponent…";
  }
  if (s.phase === "ended") {
    if (s.winner === "draw") return "Draw";
    if (myRole === "spectator") {
      const winnerIsBlack =
        (s.winner === 1 && s.blackPlayer === 1) ||
        (s.winner === 2 && s.blackPlayer === 2);
      return `${winnerIsBlack ? "Black" : "White"} wins!`;
    }
    const iWon =
      (s.winner === 1 && myRole === "p1") ||
      (s.winner === 2 && myRole === "p2");
    return iWon ? "You win!" : "You lose";
  }
  return "";
}

function buildBoard(s: State): string {
  const myTurn = isMyTurn(s);
  const color = myColor(s);

  let cells = "";
  for (let y = 0; y < 15; y++) {
    for (let x = 0; x < 15; x++) {
      const v = s.board[y][x];
      const classes = ["cell"];
      if (y === 0) classes.push("top");
      if (y === 14) classes.push("bottom");
      if (x === 0) classes.push("left");
      if (x === 14) classes.push("right");
      if (myTurn) classes.push(v === 0 ? "can-place" : "occupied");

      const isPending = pendingMove?.x === x && pendingMove?.y === y;
      const displayValue = isPending && color ? (color === "black" ? 1 : 2) : v;

      const star = STARS.has(`${x},${y}`) ? `<span class="star"></span>` : "";
      const isLast = s.lastMove?.x === x && s.lastMove?.y === y;
      const hint =
        displayValue === 0 && myTurn && color
          ? `<span class="stone-hint ${color === "black" ? "b" : "w"}"></span>`
          : "";
      const stone = displayValue
        ? `<span class="stone ${displayValue === 1 ? "b" : "w"} ${isPending ? "pending" : ""}">${isLast ? `<span class="last-move"></span>` : ""}</span>`
        : "";
      cells += `<div class="${classes.join(" ")}" data-x="${x}" data-y="${y}">${star}${hint}${stone}</div>`;
    }
  }

  return `<div class="board">${cells}</div>`;
}

function buildOverlay(s: State): string {
  if (myRole === "spectator") return "";

  if (s.phase === "waiting") {
    return `<div class="overlay"><button id="btn-copy">Copy invite link</button></div>`;
  }

  if (s.phase === "ready") {
    const iReady = s.ready[myRole as "p1" | "p2"];
    if (!iReady) {
      return `<div class="overlay"><button id="btn-ready">READY</button></div>`;
    }
  }

  if (s.phase === "ended") {
    if (waitingRematch) {
      return `<div class="overlay"><span class="overlay-hint">Waiting for opponent…</span></div>`;
    }
    return `<div class="overlay"><button id="btn-ready">REMATCH</button></div>`;
  }

  return "";
}

function bindEvents() {
  document.getElementById("btn-copy")?.addEventListener("click", () => {
    navigator.clipboard.writeText(location.href).then(() => {
      const btn = document.getElementById("btn-copy") as HTMLButtonElement;
      if (!btn) return;
      btn.textContent = "Copied!";
      setTimeout(() => {
        btn.textContent = "Copy invite link";
      }, 1500);
    });
  });

  document.getElementById("btn-ready")?.addEventListener("click", () => {
    if (state?.phase === "ended") waitingRematch = true;
    socket.send(JSON.stringify({ type: "ready" }));
    render();
  });

  document.querySelectorAll<HTMLElement>(".cell.can-place").forEach((cell) => {
    cell.addEventListener("click", () => {
      const x = Number(cell.dataset.x);
      const y = Number(cell.dataset.y);
      pendingMove = { x, y };
      tiks.click();
      render();
      socket.send(JSON.stringify({ type: "place", x, y }));
    });
  });
}
