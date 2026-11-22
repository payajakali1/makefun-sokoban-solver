// Sokoban solver for make.fun's sokoban-solver-01 (program/v1).
//
// Approach: the score of a level is set by its push count alone, so the search runs in push space,
// not move space. Levels from this generator are a hallway with independent rooms off it, so the
// solver first tries to split the level into rooms (cut the dead squares of the player's hallway
// row; each remaining part holding boxes is a room) and solves the rooms one after another, the
// other rooms' boxes standing as walls, exactly the independence the generator builds in. Each
// room (and, as a fallback, a whole level) is solved with A* over pushes:
//
//   - a state is the sorted box squares plus the player's reachable region (named by its lowest
//     square); one expansion is one push, with the walk to the pushing square filled in by BFS
//     when the answer is written out;
//   - the estimate is a minimum-cost matching of boxes to goals over precomputed push distances
//     (each goal's distances come from a reverse push BFS), which never overestimates, so the
//     first solution A* settles is push-optimal for that room;
//   - two deadlock prunes keep dead work out: a box pushed onto a square from which no goal is
//     reachable (dead square, from the same reverse BFS) and a box landing in a frozen 2x2 block
//     of walls and boxes with a box off its goal.
//
// Everything is budgeted in expanded states, never the clock, and every tie breaks by square
// order, so two runs write the same bytes. If the optimal search ever exhausts its budget, a
// weighted A* (still in push space) tries to at least solve the room; a level no search solves
// gets an empty solution.txt, which the format allows.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Directions 0..3: up, down, left, right. OPP[d] is the way back.
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const OPP = [1, 0, 3, 2];
const WALK = ['u', 'd', 'l', 'r'];
const PUSH = ['U', 'D', 'L', 'R'];

const OPT_CAP = 300_000; // expansions for the optimal search, per problem
const FALLBACK_CAP = 300_000; // expansions for the weighted fallback, per problem
let workLeft = 2_400_000; // one shared deterministic budget for the whole set

interface Board {
  w: number;
  size: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
  nbr: Int32Array; // nbr[i * 4 + d]: the square one step from i in direction d, or -1 off the board
}

/** A level in XSB text, parsed as the checker parses it (short rows padded with walls). */
function parse(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const w = Math.max(...rows.map((r) => r.length));
  const size = w * rows.length;
  const wall = new Uint8Array(size).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  const nbr = new Int32Array(size * 4).fill(-1);
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (nx >= 0 && ny >= 0 && nx < w && ny < rows.length) nbr[i * 4 + d] = ny * w + nx;
      }
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, size, wall, goals, boxes, player, nbr };
}

/** Push distances to one goal: dist[s] = fewest pushes that bring a box from s to the goal, other boxes ignored. */
function pushDistTo(board: Board, goal: number): Int32Array {
  const { wall, nbr, size } = board;
  const dist = new Int32Array(size).fill(-1);
  dist[goal] = 0;
  const queue = [goal];
  for (let qi = 0; qi < queue.length; qi++) {
    const s = queue[qi];
    for (let d = 0; d < 4; d++) {
      // Forward, a push in direction d moves a box from prev onto s, the player standing behind it.
      const prev = nbr[s * 4 + OPP[d]];
      if (prev < 0) continue;
      const stand = nbr[prev * 4 + OPP[d]];
      if (stand < 0 || wall[prev] || wall[stand] || dist[prev] >= 0) continue;
      dist[prev] = dist[s] + 1;
      queue.push(prev);
    }
  }
  return dist;
}

/** Minimum-cost matching of boxes to goals over a cost matrix (Hungarian method); Infinity when none is finite. */
function matching(cost: number[][]): number {
  const n = cost.length;
  const m = cost[0]!.length;
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(m + 1).fill(0);
  const p = new Array<number>(m + 1).fill(0); // p[j] = box matched to goal j (1-based), 0 = none
  const way = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(Infinity);
    const used = new Array<boolean>(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1]![j - 1]! - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }
  let total = 0;
  for (let j = 1; j <= m; j++) {
    if (p[j] === 0) continue;
    total += cost[p[j] - 1]![j - 1]!;
  }
  return total;
}

interface Problem {
  board: Board;
  goalSet: Uint8Array;
  dists: Int32Array[]; // one push-distance table per goal
  live: Uint8Array; // squares from which some goal is reachable
}

function prepare(board: Board): Problem {
  const goalSet = new Uint8Array(board.size);
  for (const g of board.goals) goalSet[g] = 1;
  const dists = board.goals.map((g) => pushDistTo(board, g));
  const live = new Uint8Array(board.size);
  for (let s = 0; s < board.size; s++) {
    if (board.wall[s]) continue;
    for (const d of dists) {
      if (d[s] >= 0) {
        live[s] = 1;
        break;
      }
    }
  }
  return { board, goalSet, dists, live };
}

/** The A* estimate for a box set: matching over push distances (sum of nearest goals when there are many boxes). */
function estimate(prob: Problem, boxes: number[]): number {
  const { dists } = prob;
  if (boxes.length <= 6) {
    // A large finite stand-in for "unreachable": the matching routine's arithmetic must stay
    // finite, and a total reaching it means no finite matching exists.
    const BIG = 1_000_000;
    const cost = boxes.map((b) => dists.map((d) => (d[b] < 0 ? BIG : d[b]!)));
    const total = matching(cost);
    return total >= BIG ? Infinity : total;
  }
  let total = 0;
  for (const b of boxes) {
    let best = Infinity;
    for (const d of dists) if (d[b] >= 0 && d[b]! < best) best = d[b]!;
    if (!Number.isFinite(best)) return Infinity;
    total += best;
  }
  return total;
}

/** The squares the player reaches from `from` around walls and boxes, marked in `seen` under `stamp`; the lowest one. */
function flood(board: Board, occupied: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  const { wall, nbr } = board;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let d = 0; d < 4; d++) {
      const q = nbr[p * 4 + d];
      if (q >= 0 && wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` froze: a 2x2 of walls and boxes around it holding a box off its goal. */
function frozen(prob: Problem, occupied: Uint8Array, t: number): boolean {
  const { board, goalSet } = prob;
  const { wall, nbr } = board;
  const w = board.w;
  for (const a of [t, nbr[t * 4 + 2], nbr[t * 4 + 0], (() => { const l = nbr[t * 4 + 2]; return l < 0 ? -1 : nbr[l * 4 + 0]; })()]) {
    if (a < 0) continue;
    const b = nbr[a * 4 + 3];
    const c = nbr[a * 4 + 1];
    if (b < 0 || c < 0) continue;
    const d = nbr[c * 4 + 3];
    if (d < 0) continue;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goalSet[a]) || (occupied[b] && !goalSet[b]) || (occupied[c] && !goalSet[c]) || (occupied[d] && !goalSet[d])) return true;
  }
  void w;
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters ('' when already there). */
function walk(board: Board, occupied: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const { wall, nbr, size } = board;
  const prev = new Int32Array(size).fill(-1);
  const how = new Int32Array(size).fill(-1);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (let d = 0; d < 4; d++) {
      const q = nbr[p * 4 + d];
      if (q < 0 || wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = d;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return '';
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = WALK[how[p]!] + s;
  return s;
}

interface PushStep {
  from: number; // the pushed box's square before the push
  dir: number;
}

/**
 * A* over pushes on one problem. weight 1 is push-optimal; a larger weight only runs as a fallback.
 * Returns the push sequence, or null when the expansion budget runs out first.
 */
function search(prob: Problem, cap: number, weight: number): PushStep[] | null {
  const { board, goalSet, live } = prob;
  const { wall, nbr, size } = board;
  if (board.boxes.some((b) => !live[b])) return null;
  const h0 = estimate(prob, board.boxes);
  if (!Number.isFinite(h0)) return null;
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  // State store: parallel arrays; a state's identity is its region's lowest square plus its boxes.
  const sBoxes: number[][] = [board.boxes.slice()];
  const sPlayer: number[] = [board.player];
  const sG: number[] = [0];
  const sParent: number[] = [-1];
  const sFrom: number[] = [-1];
  const sDir: number[] = [-1];
  const best = new Map<string, number>();
  const keyOf = (boxes: number[], low: number): string => String.fromCharCode(low, ...boxes);
  for (const b of board.boxes) occupied[b] = 1;
  const low0 = flood(board, occupied, board.player, seen, ++stamp, stack);
  for (const b of board.boxes) occupied[b] = 0;
  best.set(keyOf(board.boxes, low0), 0);

  // The open list: a binary heap on (f, then deeper g, then state order).
  const heap: { f: number; g: number; s: number }[] = [{ f: weight * h0, g: 0, s: 0 }];
  const before = (a: { f: number; g: number; s: number }, b: { f: number; g: number; s: number }): boolean =>
    a.f < b.f || (a.f === b.f && (a.g > b.g || (a.g === b.g && a.s < b.s)));
  const heapPush = (e: { f: number; g: number; s: number }): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!before(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): { f: number; g: number; s: number } => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && before(heap[c + 1]!, heap[c]!)) c++;
        if (!before(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  let expansions = 0;
  while (heap.length > 0) {
    const { g, s } = heapPop();
    if (g !== sG[s]) continue; // a stale heap entry: a cheaper route to this state is already stored
    const boxes = sBoxes[s]!;
    if (boxes.every((b) => goalSet[b])) {
      const steps: PushStep[] = [];
      for (let t = s; t > 0; t = sParent[t]!) steps.push({ from: sFrom[t]!, dir: sDir[t]! });
      steps.reverse();
      return steps;
    }
    if (expansions >= cap || workLeft <= 0) return null;
    expansions++;
    workLeft--;
    for (const b of boxes) occupied[b] = 1;
    flood(board, occupied, sPlayer[s]!, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      for (let d = 0; d < 4; d++) {
        const stand = nbr[b * 4 + OPP[d]];
        const target = nbr[b * 4 + d];
        if (stand < 0 || target < 0) continue;
        if (seen[stand] !== here || wall[target] || occupied[target] || !live[target]) continue;
        occupied[b] = 0;
        occupied[target] = 1;
        const isFrozen = frozen(prob, occupied, target);
        let key = '';
        let next: number[] | null = null;
        if (!isFrozen) {
          next = boxes.slice();
          next[bi] = target;
          next.sort((x, y) => x - y);
          key = keyOf(next, flood(board, occupied, b, mark, ++stamp, stack));
        }
        occupied[target] = 0;
        occupied[b] = 1;
        if (isFrozen || next === null) continue;
        const known = best.get(key);
        if (known !== undefined && known <= g + 1) continue;
        const h = estimate(prob, next);
        if (!Number.isFinite(h)) continue;
        best.set(key, g + 1);
        const t = sBoxes.length;
        sBoxes.push(next);
        sPlayer.push(b); // after the push the player stands where the box was
        sG.push(g + 1);
        sParent.push(s);
        sFrom.push(b);
        sDir.push(d);
        heapPush({ f: g + 1 + weight * h, g: g + 1, s: t });
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  return null;
}

/** Turn a push sequence into the full move string, walking the player to each push. Null if a walk fails. */
function render(board: Board, steps: PushStep[]): string | null {
  const occupied = new Uint8Array(board.size);
  const boxes = new Set(board.boxes);
  for (const b of boxes) occupied[b] = 1;
  let player = board.player;
  let moves = '';
  for (const { from, dir } of steps) {
    const stand = board.nbr[from * 4 + OPP[dir]];
    if (stand < 0) return null;
    const w = walk(board, occupied, player, stand);
    if (w === '' && player !== stand) return null;
    moves += w + PUSH[dir];
    const target = board.nbr[from * 4 + dir];
    if (target < 0) return null;
    occupied[from] = 0;
    occupied[target] = 1;
    boxes.delete(from);
    boxes.add(target);
    player = from;
  }
  return moves;
}

/** Replay a move string on the level exactly as the checker does; the push count when it solves, else -1. */
function replay(board: Board, moves: string): number {
  const { wall, nbr } = board;
  const box = new Uint8Array(board.size);
  for (const b of board.boxes) box[b] = 1;
  const goalSet = new Uint8Array(board.size);
  for (const g of board.goals) goalSet[g] = 1;
  let player = board.player;
  let pushes = 0;
  for (const ch of moves) {
    const d = WALK.indexOf(ch.toLowerCase());
    if (d < 0) return -1;
    const next = nbr[player * 4 + d];
    if (next < 0 || wall[next]) return -1;
    if (box[next]) {
      const beyond = nbr[next * 4 + d];
      if (beyond < 0 || wall[beyond] || box[beyond]) return -1;
      box[next] = 0;
      box[beyond] = 1;
      pushes++;
    }
    player = next;
  }
  for (let s = 0; s < board.size; s++) if (box[s] && !goalSet[s]) return -1;
  return pushes;
}

/** Solve one problem (a room or a whole level): optimal search first, weighted search as the fallback. */
function solveProblem(board: Board): string | null {
  const prob = prepare(board);
  for (const [cap, weight] of [
    [OPT_CAP, 1],
    [FALLBACK_CAP, 2],
  ] as const) {
    const steps = search(prob, cap, weight);
    if (steps === null) continue;
    const moves = render(board, steps);
    if (moves !== null && replay(board, moves) >= 0) return moves;
  }
  return null;
}

interface Room {
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * The level's rooms, or null when it is not a set of rooms: cut the squares of the player's row
 * that no box can ever leave toward a goal (the hallway), and each part of the floor left that
 * holds a box is a room. A part must hold as many goals as boxes, and no box or goal may sit in
 * the hallway.
 */
function roomsOf(board: Board): Room[] | null {
  const prob = prepare(board);
  const { wall, nbr, size, w } = board;
  const row = Math.floor(board.player / w);
  const cut = new Uint8Array(size);
  for (let x = 0; x < w; x++) {
    const s = row * w + x;
    if (!wall[s] && !prob.live[s]) cut[s] = 1;
  }
  if (board.boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(size).fill(-1);
  const rooms: Room[] = [];
  const stack: number[] = [];
  for (let s = 0; s < size; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const id = rooms.length;
    const squares: number[] = [];
    part[s] = id;
    stack.push(s);
    while (stack.length > 0) {
      const p = stack.pop()!;
      squares.push(p);
      for (let d = 0; d < 4; d++) {
        const q = nbr[p * 4 + d];
        if (q >= 0 && !wall[q] && !cut[q] && part[q] < 0) {
          part[q] = id;
          stack.push(q);
        }
      }
    }
    void squares;
    rooms.push({ boxes: [], goals: [], done: false });
  }
  for (const b of board.boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of board.goals) {
    if (part[g] < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Solve a level: room by room when it decomposes, the whole level otherwise (and as a rescue). */
function solveLevel(text: string): string {
  const board = parse(text);
  if (board.boxes.length === 0) return '';
  const rooms = roomsOf(board);
  if (rooms !== null) {
    let player = board.player;
    let moves = '';
    let ok = true;
    for (const room of rooms) {
      const wall = board.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
      }
      const sub: Board = { ...board, wall, goals: room.goals.slice(), boxes: room.boxes.slice(), player };
      const solved = solveProblem(sub);
      if (solved === null) {
        ok = false;
        break;
      }
      moves += solved;
      // The player ends where the room's moves leave it, on the real board.
      let p = player;
      for (const ch of solved) p = board.nbr[p * 4 + WALK.indexOf(ch.toLowerCase())]!;
      player = p;
      room.done = true;
    }
    if (ok && replay(board, moves) >= 0) return moves;
  }
  return solveProblem(board) ?? '';
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
