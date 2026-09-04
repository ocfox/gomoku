import "./styles.css";
import PartySocket from "partysocket";
import { tiks } from "@rexa-developer/tiks";

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
  winningLine: [number, number][] | null;
  yourRole: Role;
  blackPlayer: 1 | 2;
  secret?: string;
  connected?: { p1: boolean; p2: boolean };
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

const COLS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O"];
const ROWS = [15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

const SOUND_ON_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path></svg>`;
const SOUND_OFF_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>`;

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
let selectedTouchCell: { x: number; y: number } | null = null;
let resignConfirmTimer: ReturnType<typeof setTimeout> | null = null;
let isResignConfirming = false;

let prevTurn: number | null = null;
let prevPhase: Phase | null = null;
let turnStartTime = 0;
let timerInterval: ReturnType<typeof setInterval> | null = null;
let prevLastMove: { x: number; y: number } | null = null;
let isMyRecentMove = false;

// Audio setup with existing tiks library
let isMuted = localStorage.getItem("gomoku_muted") === "true";
tiks.init({ theme: "arcade", volume: 2 });
if (isMuted) {
  tiks.mute();
}

const isTouchDevice =
  typeof window !== "undefined" &&
  (window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window);

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

  // Sound triggers using tiks
  if (msg.phase === "playing") {
    if (msg.lastMove) {
      const isNewMove =
        !prevLastMove ||
        prevLastMove.x !== msg.lastMove.x ||
        prevLastMove.y !== msg.lastMove.y;
      if (isNewMove) {
        if (!isMyRecentMove) {
          tiks.pop();
        }
        prevLastMove = msg.lastMove;
      }
    }
    isMyRecentMove = false;

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

    if (prevPhase === "playing" && msg.phase === "ended") {
      const iWon =
        (msg.winner === 1 && myRole === "p1") ||
        (msg.winner === 2 && myRole === "p2");
      const iLost =
        (msg.winner === 1 && myRole === "p2") ||
        (msg.winner === 2 && myRole === "p1");
      if (iWon) tiks.success();
      else if (iLost) tiks.error();
    }
  }

  prevPhase = msg.phase;
  pendingMove = null;
  selectedTouchCell = null;
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

function isOpponentDisconnected(s: State): boolean {
  if (!s.connected || myRole === "spectator") return false;
  if (s.phase !== "playing" && s.phase !== "ready") return false;
  if (myRole === "p1") return !s.connected.p2;
  if (myRole === "p2") return !s.connected.p1;
  return false;
}

// DOM Elements Cache
let boardElement: HTMLElement | null = null;
let cellElements: HTMLElement[][] = [];

function ensureBaseDOM() {
  const app = document.getElementById("app")!;
  if (boardElement && app.querySelector(".game")) return;

  app.innerHTML = `
    <div class="game">
      <div class="game-header">
        <div class="room-info" id="room-tag" title="Click to copy invite link">
          <span class="room-label">ROOM</span>
          <span class="room-id">#${roomId}</span>
        </div>
        <div class="header-tools">
          <button id="btn-sound" class="icon-btn" aria-label="Toggle sound" title="Sound ${isMuted ? "Off" : "On"}">${isMuted ? SOUND_OFF_ICON : SOUND_ON_ICON}</button>
          <button id="btn-copy" class="pill-btn" title="Copy invite link">Copy Link</button>
        </div>
      </div>

      <div class="board-meta">
        <div class="status-wrap">
          <span class="status" id="status-text"></span>
        </div>
        <div class="right-meta">
          <span id="timer" class="timer"></span>
          <div class="scores" id="scores-wrap"></div>
          <button id="btn-resign" class="btn-resign hidden" title="Resign game">Resign</button>
        </div>
      </div>

      <div class="board-layout">
        <div class="coord-col coord-col-top">
          ${COLS.map((c) => `<span>${c}</span>`).join("")}
        </div>
        <div class="board-center-row">
          <div class="coord-row coord-row-left">
            ${ROWS.map((r) => `<span>${r}</span>`).join("")}
          </div>
          <div class="board-wrap">
            <div class="board" id="board"></div>
            <div class="overlay" id="overlay"></div>
          </div>
          <div class="coord-row coord-row-right">
            ${ROWS.map((r) => `<span>${r}</span>`).join("")}
          </div>
        </div>
        <div class="coord-col coord-col-bottom">
          ${COLS.map((c) => `<span>${c}</span>`).join("")}
        </div>
      </div>
    </div>
  `;

  boardElement = document.getElementById("board")!;
  cellElements = [];

  for (let y = 0; y < 15; y++) {
    cellElements[y] = [];
    for (let x = 0; x < 15; x++) {
      const cell = document.createElement("div");
      const classes = ["cell"];
      if (y === 0) classes.push("top");
      if (y === 14) classes.push("bottom");
      if (x === 0) classes.push("left");
      if (x === 14) classes.push("right");
      cell.className = classes.join(" ");
      cell.dataset.x = String(x);
      cell.dataset.y = String(y);

      if (STARS.has(`${x},${y}`)) {
        const star = document.createElement("span");
        star.className = "star";
        cell.appendChild(star);
      }

      cell.addEventListener("click", () => handleCellClick(x, y));
      boardElement.appendChild(cell);
      cellElements[y][x] = cell;
    }
  }

  bindHeaderAndActionEvents();
}

function handleCellClick(x: number, y: number) {
  if (!state || !isMyTurn(state)) return;
  if (state.board[y][x] !== 0) return;

  // Touch screen anti-misclick confirmation
  if (isTouchDevice) {
    if (selectedTouchCell?.x === x && selectedTouchCell?.y === y) {
      // Confirmed tap
      executeMove(x, y);
      selectedTouchCell = null;
    } else {
      // First tap selects cell
      selectedTouchCell = { x, y };
      if ("vibrate" in navigator) navigator.vibrate?.(10);
      renderBoardCells(state);
      return;
    }
  } else {
    // Desktop mouse single-click
    executeMove(x, y);
  }
}

function executeMove(x: number, y: number) {
  pendingMove = { x, y };
  isMyRecentMove = true;
  tiks.click();
  if ("vibrate" in navigator) navigator.vibrate?.(15);
  render();
  socket.send(JSON.stringify({ type: "place", x, y }));
}

function render() {
  if (!state) return;
  ensureBaseDOM();
  renderMeta(state);
  renderBoardCells(state);
  renderOverlay(state);
}

function renderMeta(s: State) {
  const statusEl = document.getElementById("status-text");
  const scoresEl = document.getElementById("scores-wrap");
  const timerEl = document.getElementById("timer");
  const resignBtn = document.getElementById("btn-resign") as HTMLButtonElement | null;

  if (statusEl) {
    const oppOffline = isOpponentDisconnected(s);
    statusEl.textContent = statusText(s);
    statusEl.className = `status ${oppOffline ? "status-offline" : ""}`;
  }

  if (timerEl) {
    timerEl.textContent = s.phase === "playing" ? elapsed() : "";
  }

  if (scoresEl) {
    const p1IsBlack = s.blackPlayer === 1;
    const blackScore = p1IsBlack ? s.scores.p1 : s.scores.p2;
    const whiteScore = p1IsBlack ? s.scores.p2 : s.scores.p1;
    const iAmBlack = myColor(s) === "black";
    const iAmWhite = myColor(s) === "white";

    scoresEl.innerHTML = `
      <span class="score-b ${iAmBlack ? "you" : ""}">● ${blackScore}</span>
      <span class="score-w ${iAmWhite ? "you" : ""}">○ ${whiteScore}</span>
    `;
  }

  if (resignBtn) {
    if (s.phase === "playing" && myRole !== "spectator") {
      resignBtn.classList.remove("hidden");
      if (!isResignConfirming) {
        resignBtn.textContent = "Resign";
        resignBtn.classList.remove("confirming");
      }
    } else {
      resignBtn.classList.add("hidden");
      isResignConfirming = false;
      if (resignConfirmTimer) {
        clearTimeout(resignConfirmTimer);
        resignConfirmTimer = null;
      }
    }
  }
}

function renderBoardCells(s: State) {
  const myTurn = isMyTurn(s);
  const color = myColor(s);

  for (let y = 0; y < 15; y++) {
    for (let x = 0; x < 15; x++) {
      const cell = cellElements[y]?.[x];
      if (!cell) continue;

      const v = s.board[y][x];
      const isPending = pendingMove?.x === x && pendingMove?.y === y;
      const displayValue = isPending && color ? (color === "black" ? 1 : 2) : v;

      // Update placeable classes
      if (myTurn) {
        cell.classList.toggle("can-place", displayValue === 0);
        cell.classList.toggle("occupied", displayValue !== 0);
      } else {
        cell.classList.remove("can-place");
        cell.classList.toggle("occupied", displayValue !== 0);
      }

      // Touch selected preview
      const isTouchSelected = selectedTouchCell?.x === x && selectedTouchCell?.y === y;
      cell.classList.toggle("touch-selected", isTouchSelected);

      // Existing elements in cell
      let stoneEl = cell.querySelector<HTMLElement>(".stone");
      let hintEl = cell.querySelector<HTMLElement>(".stone-hint");

      // Update Stone
      if (displayValue !== 0) {
        const stoneColorClass = displayValue === 1 ? "b" : "w";
        const isLast = s.lastMove?.x === x && s.lastMove?.y === y;

        if (!stoneEl) {
          stoneEl = document.createElement("span");
          stoneEl.className = `stone ${stoneColorClass}`;
          cell.appendChild(stoneEl);
        } else {
          stoneEl.className = `stone ${stoneColorClass}`;
        }

        if (isPending) stoneEl.classList.add("pending");

        let lastMoveEl = stoneEl.querySelector<HTMLElement>(".last-move");
        if (isLast) {
          if (!lastMoveEl) {
            lastMoveEl = document.createElement("span");
            lastMoveEl.className = "last-move";
            stoneEl.appendChild(lastMoveEl);
          }
        } else if (lastMoveEl) {
          lastMoveEl.remove();
        }

        if (hintEl) hintEl.remove();
      } else {
        if (stoneEl) stoneEl.remove();

        // Update hover / selection hint
        if (myTurn && color) {
          const hintColor = color === "black" ? "b" : "w";
          if (!hintEl) {
            hintEl = document.createElement("span");
            hintEl.className = `stone-hint ${hintColor}`;
            cell.appendChild(hintEl);
          } else {
            hintEl.className = `stone-hint ${hintColor}`;
          }
        } else if (hintEl) {
          hintEl.remove();
        }
      }
    }
  }
}

function renderOverlay(s: State) {
  const overlay = document.getElementById("overlay");
  if (!overlay) return;

  if (myRole === "spectator") {
    overlay.innerHTML = "";
    return;
  }

  if (s.phase === "waiting") {
    overlay.innerHTML = `<button id="btn-overlay-copy">Copy invite link</button>`;
    document.getElementById("btn-overlay-copy")?.addEventListener("click", copyInviteLink);
    return;
  }

  if (s.phase === "ready") {
    const iReady = s.ready[myRole as "p1" | "p2"];
    if (!iReady) {
      overlay.innerHTML = `<button id="btn-overlay-ready">READY</button>`;
      document.getElementById("btn-overlay-ready")?.addEventListener("click", () => {
        tiks.click();
        socket.send(JSON.stringify({ type: "ready" }));
      });
      return;
    }
  }

  if (s.phase === "ended") {
    if (waitingRematch) {
      overlay.innerHTML = `<span class="overlay-hint">Waiting for opponent…</span>`;
    } else {
      overlay.innerHTML = `<button id="btn-overlay-ready">REMATCH</button>`;
      document.getElementById("btn-overlay-ready")?.addEventListener("click", () => {
        tiks.click();
        waitingRematch = true;
        socket.send(JSON.stringify({ type: "ready" }));
        render();
      });
    }
    return;
  }

  overlay.innerHTML = "";
}

function statusText(s: State): string {
  if (isOpponentDisconnected(s)) {
    return "Opponent offline… waiting";
  }
  if (s.phase === "waiting") return "Waiting for opponent…";
  if (s.phase === "ready") {
    if (myRole === "spectator") return "Waiting for players";
    const iReady = s.ready[myRole as "p1" | "p2"];
    return iReady ? "Waiting for opponent…" : "Press READY to play";
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
    if (s.winner === "draw") return "Draw!";
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

function copyInviteLink() {
  navigator.clipboard.writeText(location.href).then(() => {
    const btn = document.getElementById("btn-copy") as HTMLButtonElement | null;
    const overlayBtn = document.getElementById("btn-overlay-copy") as HTMLButtonElement | null;
    const roomTag = document.getElementById("room-tag");

    if (btn) btn.textContent = "Copied!";
    if (overlayBtn) overlayBtn.textContent = "Copied!";
    if (roomTag) roomTag.classList.add("copied");

    setTimeout(() => {
      if (btn) btn.textContent = "Copy Link";
      if (overlayBtn) overlayBtn.textContent = "Copy invite link";
      if (roomTag) roomTag.classList.remove("copied");
    }, 1600);
  });
}

function bindHeaderAndActionEvents() {
  document.getElementById("btn-copy")?.addEventListener("click", copyInviteLink);
  document.getElementById("room-tag")?.addEventListener("click", copyInviteLink);

  // Sound toggle button
  document.getElementById("btn-sound")?.addEventListener("click", () => {
    isMuted = !isMuted;
    localStorage.setItem("gomoku_muted", String(isMuted));
    if (isMuted) {
      tiks.mute();
    } else {
      tiks.unmute();
      tiks.click();
    }
    const btn = document.getElementById("btn-sound");
    if (btn) {
      btn.innerHTML = isMuted ? SOUND_OFF_ICON : SOUND_ON_ICON;
      btn.title = `Sound ${isMuted ? "Off" : "On"}`;
    }
  });

  // Resign button
  const resignBtn = document.getElementById("btn-resign");
  resignBtn?.addEventListener("click", () => {
    if (!isResignConfirming) {
      isResignConfirming = true;
      resignBtn.textContent = "Confirm?";
      resignBtn.classList.add("confirming");
      resignConfirmTimer = setTimeout(() => {
        isResignConfirming = false;
        resignBtn.textContent = "Resign";
        resignBtn.classList.remove("confirming");
      }, 3000);
    } else {
      if (resignConfirmTimer) clearTimeout(resignConfirmTimer);
      isResignConfirming = false;
      resignBtn.textContent = "Resign";
      resignBtn.classList.remove("confirming");
      socket.send(JSON.stringify({ type: "resign" }));
    }
  });
}
