[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/payajakali1/makefun-sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/payajakali1/makefun-sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

Entry for the [make.fun bounty: sokoban-solver-01-run-20261121](https://make.fun/bounty/sokoban-solver-01-run-20261121) by **payaja**.

---

# Sokoban solver — push-space A* with room decomposition

Entry for make.fun's "Build the best Sokoban solver, 21 November 2026"
(sokoban-solver-01-run-20261121). `main.ts` reads each level from
`MAKEFUN_INPUT_DIR/<id>/level.txt` and writes the player's moves (LURD) to
`MAKEFUN_OUTPUT_DIR/<id>/solution.txt`.

## Approach

A level's score depends only on its push count, so the search runs in push
space, not move space:

- **Room decomposition.** Levels from this generator are a one-square-wide
  hallway with independent rooms off it. The solver cuts the dead squares of
  the player's hallway row; each remaining part of the floor that holds boxes
  is a room. Rooms are solved one after another with the other rooms' boxes
  standing as walls (on their start squares, or on their goals once solved),
  and the player walks on from where the previous room left them. If a level
  does not decompose, the whole level is searched as one problem.
- **A\* over pushes.** A state is the sorted box squares plus the player's
  reachable region (named by its lowest square); one expansion is one push,
  and the walk to each pushing square is filled in by BFS when the answer is
  written out. The estimate is a minimum-cost matching of boxes to goals over
  precomputed push distances (a reverse push BFS per goal). It never
  overestimates, so the first solution settled is push-optimal for the room.
- **Deadlock pruning.** A push onto a dead square (no goal reachable from it,
  from the same reverse BFS) is never made, and a box landing in a frozen
  2x2 block of walls and boxes with a box off its goal prunes the state.
- **Determinism.** All budgets are counted in expanded states, never the
  clock, and every tie breaks by square order, so two runs write the same
  bytes. If the optimal search ever exhausts its budget, a weighted A*
  (weight 2) tries to at least solve the problem; a level no search solves
  gets an empty `solution.txt`, which the format allows.

On the kit's practice set this solves all five levels in the optimal number
of pushes (13 / 16 / 29 / 47 / 60) in well under a second.
