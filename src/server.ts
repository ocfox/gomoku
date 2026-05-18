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
	ready: { black: boolean; white: boolean };
	scores: { black: number; white: number };
	lastMove: { x: number; y: number } | null;
	players: { black: PlayerInfo | null; white: PlayerInfo | null };
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
		ready: { black: false, white: false },
		scores: { black: 0, white: 0 },
		lastMove: null,
		players: { black: null, white: null },
	};
}

function checkWin(board: number[][], x: number, y: number, p: number): boolean {
	const dirs: [number, number][] = [
		[1, 0],
		[0, 1],
		[1, 1],
		[1, -1],
	];
	for (const [dx, dy] of dirs) {
		let count = 1;
		for (let i = 1; i < 5; i++) {
			const nx = x + dx * i,
				ny = y + dy * i;
			if (nx < 0 || nx >= 15 || ny < 0 || ny >= 15 || board[ny][nx] !== p)
				break;
			count++;
		}
		for (let i = 1; i < 5; i++) {
			const nx = x - dx * i,
				ny = y - dy * i;
			if (nx < 0 || nx >= 15 || ny < 0 || ny >= 15 || board[ny][nx] !== p)
				break;
			count++;
		}
		if (count >= 5) return true;
	}
	return false;
}

export class GomokuServer extends Server<Env> {
	state: ServerState = makeState();

	async onStart() {
		const stored = await this.ctx.storage.get<ServerState>("state");
		if (stored) this.state = stored;
	}

	async onConnect(conn: Connection) {
		await this.ctx.storage.deleteAlarm();
		this.sendTo(conn, "spectator");
	}

	async onClose() {
		if ([...this.getConnections()].length === 0) {
			await this.ctx.storage.setAlarm(Date.now() + 5 * 60 * 1000);
		}
	}

	async onAlarm() {
		await this.ctx.storage.deleteAll();
		this.state = makeState();
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

		if (msg.type === "join") await this.handleJoin(conn, msg.role, msg.secret);
		else if (msg.type === "ready") await this.handleReady(conn.id);
		else if (msg.type === "place")
			await this.handlePlace(conn.id, msg.x!, msg.y!);
	}

	async handleJoin(conn: Connection, role?: string, secret?: string) {
		const { players } = this.state;

		if (
			role === "black" &&
			players.black !== null &&
			players.black.secret === secret
		) {
			players.black.connId = conn.id;
			this.sendTo(conn, "black");
			return;
		}
		if (
			role === "white" &&
			players.white !== null &&
			players.white.secret === secret
		) {
			players.white.connId = conn.id;
			this.sendTo(conn, "white");
			return;
		}

		const newSecret = crypto.randomUUID().slice(0, 8);

		if (!players.black) {
			players.black = { connId: conn.id, secret: newSecret };
			await this.save();
			this.sendToWithSecret(conn, "black", newSecret);
			return;
		}

		if (!players.white) {
			players.white = { connId: conn.id, secret: newSecret };
			if (this.state.phase === "waiting") this.state.phase = "ready";
			await this.save();
			this.sendToWithSecret(conn, "white", newSecret);
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

		if (this.state.ready.black && this.state.ready.white) {
			[this.state.players.black, this.state.players.white] =
				[this.state.players.white, this.state.players.black];
			this.state.board = makeBoard();
			this.state.turn = 1;
			this.state.winner = null;
			this.state.ready = { black: false, white: false };
			this.state.lastMove = null;
			this.state.phase = "playing";
		}

		await this.save();
		this.broadcastAll();
	}

	async handlePlace(connId: string, x: number, y: number) {
		const { board, phase, turn } = this.state;
		if (phase !== "playing") return;

		const role = this.getRole(connId);
		if (role === "spectator") return;
		const playerNum = role === "black" ? 1 : 2;
		if (playerNum !== turn) return;
		if (x < 0 || x >= 15 || y < 0 || y >= 15) return;
		if (board[y][x] !== 0) return;

		board[y][x] = playerNum;
		this.state.lastMove = { x, y };

		if (checkWin(board, x, y, playerNum)) {
			this.state.phase = "ended";
			this.state.winner = playerNum as 1 | 2;
			this.state.scores[role]++;
			this.state.ready = { black: false, white: false };
		} else if (board.every((row) => row.every((v) => v !== 0))) {
			this.state.phase = "ended";
			this.state.winner = "draw";
			this.state.ready = { black: false, white: false };
		} else {
			this.state.turn = turn === 1 ? 2 : 1;
		}

		await this.save();
		this.broadcastAll();
	}

	getRole(connId: string): "black" | "white" | "spectator" {
		if (this.state.players.black?.connId === connId) return "black";
		if (this.state.players.white?.connId === connId) return "white";
		return "spectator";
	}

	publicState() {
		const { players: _players, ...pub } = this.state;
		return pub;
	}

	sendTo(conn: Connection, role: string) {
		conn.send(
			JSON.stringify({ type: "state", ...this.publicState(), yourRole: role }),
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
