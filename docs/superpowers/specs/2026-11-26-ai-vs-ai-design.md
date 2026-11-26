# AI vs AI mode (short design)

## Intent
Let a person pick two AIs from the AI Unlimited list and watch them play each other in the browser. Watching two AIs
play is the fun part of AI Unlimited (README), and today it is only reachable from the console (`__pika.setArena`).

## Goals
- An "AI vs AI" button in the 혼자 하기 row. It opens the AI Unlimited list.
- In the list, the first AI clicked plays 1P, the next 2P, then 1P again, and so on. Each card shows a 1P/2P badge.
- A ready matchup from the moment the mode opens (last pair, else rank 1 vs rank 2), so Enter always starts a game.
- The same AI may play both sides.
- The viewer only watches: the keyboard moves neither Pikachu; Enter starts/restarts, pause still works.
- Names on screen instead of "CPU": title line `AI VS AI - <1P> VS <2P>`, HUD corners and head tags, `<NAME> WINS!`.

## Non-goals / anti-goals
- No change to how any AI plays, to `tools/arena.mjs` results, or to online play.
- Built-in levels (easy..korean) are not offered in this mode (AI Unlimited only, as asked).

## Approach
Only one sensible way: reuse `setArena(p1, p2, seed)` (already makes both sides AI-driven and ignores the keyboard)
with a random seed, and add UI around it in the existing mode-picker block of `game.js` plus a button in
`index.html`. Building a separate spectate path would duplicate what `setArena` already does.

## Left to the builder
Exact badge styling, status wording.
