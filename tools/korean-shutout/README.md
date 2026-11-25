# Korean CPU: 11–0 without crossing the net or zapping

Run from the repository root with Node.js 22+ (no installation needed):

```sh
node tools/korean-shutout/run.mjs
```

The default seeds are `1728 1` (game, CPU); the CPU serves first. Optional seed
arguments explore other games. Other seeds are not guaranteed shutouts, and the
script exits nonzero if the invariants fail. This is a single-match benchmark,
not a general claim about matchmaking or CPU difficulty.

The pilot reads the existing `__pika` debug state and uses the game's ordinary
1P key inputs. The harness imports the real game and Korean CPU, replacing only
browser/UI plumbing and fixing the random seeds in the offline process. Once the
match starts it does not set player positions, scores, or the shuttle state.
The harness rejects any input outside the allowlist: Enter to start;
A/D to move; W to jump; H to dash within 1P's court; F to serve/return; and
S as a shot modifier. It samples 1P's position every simulated tick and checks
that each point is a 1P shot landing inside 2P's court, rather than a CPU error.

## Strategy

1. Serve from near the service line. Between contacts, recover to midcourt and
   shade toward the net for short balls. Read incoming bolts to jump over them
   if necessary, but don't fire any.
2. Roll the shuttle forward with the game's drag, gravity, and net collision.
   Search for a contact over the next few frames, testing walking positions,
   jump timings, and dashes. Rule out movement beyond 1P's side of the net.
3. For each attainable contact, predict the landing of the available shots.
   Reject net, short, and out shots. Favor a return that leaves the CPU little
   time to move to its best interception point. An airborne F contact turns
   into Iron Tail; the pilot doesn't need a separate smash input.

The equivalent strategy won a real browser match 11–0 (31 observed 1P contacts,
21 smashes; no net crossing or zaps). The seeded run is a separate match, not a
recording of that browser session. Unlike the sequence fixed by #1, this strategy
doesn't need the CPU to turn away from the opposite court. A balance change can
reduce this pilot's score; that's useful benchmark data rather than necessarily
a game regression. No gameplay code or CI is changed by this tool.
