import { Server, routePartykitRequest } from "partyserver";
import type { Connection } from "partyserver";

type Phase = "waiting" | "ready" | "playing" | "ended";

interface PlayerInfo {
  connId: string;
  secret: string;
}

interface ServerState {
  board: number[][];
  phase: Phase;
  turn: 1 | 2;
  winner: 1 | 2 | "draw" | null;
  ready: { p1: boolean; p2: boolean };
  scores: { p1: number; p2: number };
  lastMove: { x: number; y: number } | null;
  winningLine: [number, number][] | null;
  players: { p1: PlayerInfo | null; p2: PlayerInfo | null };
  blackPlayer: 1 | 2;
}

interface Env {
  ASSETS: Fetcher;
}

function makeBoard(): number[][] {
  return Array.from({ length: 15 }, () => Array(15).fill(0));
}

function makeState(): ServerState {
  return {
    board: makeBoard(),
    phase: "waiting",
    turn: 1,
    winner: null,
    ready: { p1: false, p2: false },
    scores: { p1: 0, p2: 0 },
    lastMove: null,
    winningLine: null,
    players: { p1: null, p2: null },
    blackPlayer: 1,
  };
}

function findWinningLine(
  board: number[][],
  x: number,
  y: number,
  p: number,
): [number, number][] | null {
  const dirs: [number, number][] = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ];
  for (const [dx, dy] of dirs) {
    const line: [number, number][] = [[x, y]];
    for (let i = 1; i < 15; i++) {
      const nx = x + dx * i,
        ny = y + dy * i;
      if (nx < 0 || nx >= 15 || ny < 0 || ny >= 15 || board[ny][nx] !== p)
        break;
      line.push([nx, ny]);
    }
    for (let i = 1; i < 15; i++) {
      const nx = x - dx * i,
        ny = y - dy * i;
      if (nx < 0 || nx >= 15 || ny < 0 || ny >= 15 || board[ny][nx] !== p)
        break;
      line.unshift([nx, ny]);
    }
    if (line.length >= 5) return line;
  }
  return null;
}

export class GomokuRoom extends Server<Env> {
  static options = { hibernate: true };

  state: ServerState = makeState();

  async onStart() {
    const stored = await this.ctx.storage.get<ServerState>("state");
    if (stored) {
      this.state = {
        ...makeState(),
        ...stored,
        winningLine: stored.winningLine ?? null,
      };
    }
  }

  async onConnect(conn: Connection) {
    this.sendTo(conn, "spectator");
    await this.ctx.storage.deleteAlarm();
  }

  async onClose(conn: Connection) {
    const remaining = [...this.getConnections()].filter(
      (c) => c.id !== conn.id,
    );
    if (remaining.length === 0) {
      await this.ctx.storage.setAlarm(Date.now() + 5 * 60 * 1000);
    } else {
      for (const c of remaining) {
        this.sendToWithClosing(c, this.getRole(c.id), conn.id);
      }
    }
  }

  async onAlarm() {
    this.state = makeState();
    await this.save();
  }

  async onMessage(conn: Connection, raw: string) {
    let msg: {
      type: string;
      role?: string;
      secret?: string;
      x?: number;
      y?: number;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "join") await this.handleJoin(conn, msg.secret);
    else if (msg.type === "ready") await this.handleReady(conn.id);
    else if (msg.type === "place")
      await this.handlePlace(conn.id, msg.x!, msg.y!);
    else if (msg.type === "resign") await this.handleResign(conn.id);
  }

  async handleJoin(conn: Connection, secret?: string) {
    const { players } = this.state;

    // Match by secret — the stable identity across reconnects and color swaps
    if (secret) {
      if (players.p1?.secret === secret) {
        players.p1.connId = conn.id;
        this.sendTo(conn, "p1");
        this.broadcastAll();
        return;
      }
      if (players.p2?.secret === secret) {
        players.p2.connId = conn.id;
        this.sendTo(conn, "p2");
        this.broadcastAll();
        return;
      }
    }

    const newSecret = crypto.randomUUID().slice(0, 8);

    if (!players.p1) {
      players.p1 = { connId: conn.id, secret: newSecret };
      await this.save();
      this.sendToWithSecret(conn, "p1", newSecret);
      this.broadcastExcept(conn.id);
      return;
    }

    if (!players.p2) {
      players.p2 = { connId: conn.id, secret: newSecret };
      if (this.state.phase === "waiting") this.state.phase = "ready";
      await this.save();
      this.sendToWithSecret(conn, "p2", newSecret);
      this.broadcastExcept(conn.id);
      return;
    }

    this.sendTo(conn, "spectator");
  }

  async handleReady(connId: string) {
    const role = this.getRole(connId);
    if (role === "spectator") return;
    if (this.state.phase !== "ready" && this.state.phase !== "ended") return;

    this.state.ready[role] = true;

    if (this.state.ready.p1 && this.state.ready.p2) {
      // Alternate who plays black each round
      this.state.blackPlayer = this.state.blackPlayer === 1 ? 2 : 1;
      this.state.board = makeBoard();
      // Black always moves first; turn = the player number who is black this round
      this.state.turn = this.state.blackPlayer;
      this.state.winner = null;
      this.state.winningLine = null;
      this.state.ready = { p1: false, p2: false };
      this.state.lastMove = null;
      this.state.phase = "playing";
    }

    await this.save();
    this.broadcastAll();
  }

  async handlePlace(connId: string, x: number, y: number) {
    const { board, phase, turn, blackPlayer } = this.state;
    if (phase !== "playing") return;

    const role = this.getRole(connId);
    if (role === "spectator") return;
    const playerNum = role === "p1" ? 1 : 2;
    if (playerNum !== turn) return;
    if (!Number.isInteger(x) || !Number.isInteger(y)) return;
    if (x < 0 || x >= 15 || y < 0 || y >= 15) return;
    if (board[y][x] !== 0) return;

    // Board uses 1=black stone, 2=white stone
    const stoneValue = playerNum === blackPlayer ? 1 : 2;
    board[y][x] = stoneValue;
    this.state.lastMove = { x, y };

    const winningLine = findWinningLine(board, x, y, stoneValue);
    if (winningLine) {
      this.state.phase = "ended";
      this.state.winner = playerNum as 1 | 2;
      this.state.winningLine = winningLine;
      this.state.scores[role]++;
      this.state.ready = { p1: false, p2: false };
    } else if (board.every((row) => row.every((v) => v !== 0))) {
      this.state.phase = "ended";
      this.state.winner = "draw";
      this.state.winningLine = null;
      this.state.ready = { p1: false, p2: false };
    } else {
      this.state.turn = turn === 1 ? 2 : 1;
    }

    await this.save();
    this.broadcastAll();
  }

  async handleResign(connId: string) {
    if (this.state.phase !== "playing") return;
    const role = this.getRole(connId);
    if (role === "spectator") return;

    const playerNum = role === "p1" ? 1 : 2;
    const winnerNum = playerNum === 1 ? 2 : 1;
    const winnerRole = winnerNum === 1 ? "p1" : "p2";

    this.state.phase = "ended";
    this.state.winner = winnerNum;
    this.state.winningLine = null;
    this.state.scores[winnerRole]++;
    this.state.ready = { p1: false, p2: false };

    await this.save();
    this.broadcastAll();
  }

  isPlayerConnected(
    player: PlayerInfo | null,
    closingConnId?: string,
  ): boolean {
    if (!player) return false;
    return [...this.getConnections()].some(
      (c) => c.id === player.connId && c.id !== closingConnId,
    );
  }

  getRole(connId: string): "p1" | "p2" | "spectator" {
    if (this.state.players.p1?.connId === connId) return "p1";
    if (this.state.players.p2?.connId === connId) return "p2";
    return "spectator";
  }

  publicState(closingConnId?: string) {
    const { players: _players, ...pub } = this.state;
    return {
      ...pub,
      connected: {
        p1: this.isPlayerConnected(this.state.players.p1, closingConnId),
        p2: this.isPlayerConnected(this.state.players.p2, closingConnId),
      },
    };
  }

  sendTo(conn: Connection, role: string) {
    conn.send(
      JSON.stringify({ type: "state", ...this.publicState(), yourRole: role }),
    );
  }

  sendToWithClosing(conn: Connection, role: string, closingConnId: string) {
    conn.send(
      JSON.stringify({
        type: "state",
        ...this.publicState(closingConnId),
        yourRole: role,
      }),
    );
  }

  sendToWithSecret(conn: Connection, role: string, secret: string) {
    conn.send(
      JSON.stringify({
        type: "state",
        ...this.publicState(),
        yourRole: role,
        secret,
      }),
    );
  }

  broadcastAll() {
    for (const conn of this.getConnections()) {
      this.sendTo(conn, this.getRole(conn.id));
    }
  }

  broadcastExcept(excludeId: string) {
    for (const conn of this.getConnections()) {
      if (conn.id !== excludeId) this.sendTo(conn, this.getRole(conn.id));
    }
  }

  async save() {
    await this.ctx.storage.put("state", this.state);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routePartykitRequest(request, env)) ?? env.ASSETS.fetch(request)
    );
  },
} satisfies ExportedHandler<Env>;
