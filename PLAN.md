# Dice Game: Plan

A multiplayer dice game for 2–5 players, played in the browser, mostly on phones.
A host creates a game, shares a code/link, players join a lobby, the host starts.
Everyone watches every turn live.

## Rules

### A turn
- Roll 5 dice. At least one die must score on every roll; set the scoring dice aside.
- After setting dice aside, either **roll the remaining dice** or **bank** the turn's points.
- A roll with nothing that scores is a **crap-out**: the turn ends and scores 0.
- **Hot dice:** once all five dice have scored (in one roll or over several), pick all
  five back up and keep going.
- Every die you set aside must be part of a scoring combo. When the same dice can be
  grouped more than one way, you get the best grouping.

### Scoring (combos only count within a single roll)
| Combo | Points |
|---|---|
| Each 1 | 100 |
| Each 5 | 50 |
| Three of a kind | 1s = 1,000; others face × 100 |
| Four of a kind | 2 × three of a kind |
| Five of a kind | 2 × four of a kind |
| 4 in a row (1-4, 2-5, 3-6) | 250 |
| 5 in a row (1-5, 2-6) | 500 |
| Full house | three-of-a-kind value of the triple + three-of-a-kind value of the pair (a pair of 1s counts 200) |

Full house examples: 2s & 5s = 700 · 6s & 4s = 1,000 · three 2s + two 1s = 400 · three 1s + two 6s = 1,600.

Several combos can be set aside from the same roll (e.g. three 4s + a 1 + a 5 = 550).

### Getting on the board
- A player's first bank must be at least **350** in a single turn.
- Until then they can't bank, and they can't carry on from someone else's live dice.

### Live dice
- After a player banks, the next player may **carry on** from that turn: start with the
  banked points and roll the dice that were left (all five after hot dice).
  Or they can **start fresh** with 0 points and five dice.
- Carrying on works like a normal turn: crap out and you get nothing; bank and the
  whole amount (inherited points included) goes on your score.
- Live dice are dead for a player who isn't on the board yet, and for a player they
  would push over 10,000. Both players get a warning: the banker sees the next player
  can't build on it, and the next player sees why they're starting fresh.

### Winning
- First to score **exactly 10,000** wins.
- You can't set aside dice that would take you over 10,000.
- **Exact roll:** on the roll that lands on 10,000, every scoring die counts, chosen or
  not. You can't pick out dice to finish: the whole roll has to score exactly what you
  need. If it scores more, you can still set aside less and keep rolling.
  - At 9,800, rolling 1, 1, 5, 4, 4 (250) can't finish with the two 1s. Keep the 1 and
    5 (150) and roll three dice. Then 1, 5, 4 craps out: the 5 alone would make 10,000,
    but the 1 counts too.
  - Needing 50, a single 5 wins; two 5s (100) end the turn with nothing.
- If no allowed choice is left in a roll, it counts as a crap-out.

### Open questions
1. ~~**Two 5s at 9,950**~~: settled by the exact roll rule: the turn ends.
2. **Crapping out on live dice:** the rules say carrying on and scoring nothing ends the
   turn, but the Person C example then has C take five dice and keep rolling. The
   current build ends the turn. Does a miss on live dice instead let you start fresh?
3. **Person D example:** C banked 500, but D's line says 400. Presumably a typo.
4. Any rule for a final round once someone reaches 10,000? (Not needed if it must be
   exact: the first to hit it wins.)

## Architecture

- `packages/shared`: rules engine in TypeScript, pure and fully unit-tested.
  - `scoring.ts`: combos, best grouping, crap-out detection.
  - `turn.ts`: one turn's state machine (roll → keep → roll/bank), 10,000 cap, 350 opening.
  - `game.ts`: players, turn order, live dice, winning. Serializable, so the server can
    hold it and send it to every player.
  - `protocol.ts`: the messages between browser and server.
- `packages/server`: Cloudflare Worker + Durable Objects (free plan). Live at
  **https://dice.mjgibson.com**.
  - `worker.ts`: serves the app, `POST /api/rooms` (create), `GET /api/rooms/CODE` (check),
    and hands `/ws/CODE` to that room's Durable Object. One Durable Object per game code
    holds the game, rolls the dice (crypto-random), and saves the room after every change,
    so games survive the object sleeping or restarting. The 5-second turn-over pause and
    the cleanup of rooms empty for 30 minutes run on Durable Object alarms.
  - `room.ts`: seats, lobby, host, turns. No platform code, unit-tested.
- `packages/client`: Vite + React, mobile-first.
  - Home: create a game (pick 2–5 players), join with a code, or practice.
  - `/room/CODE`: join form (for invite links), lobby with share button, live game, end screen.
  - Everyone sees every roll, every die the current player taps, banks and crap-outs live.
  - Your seat is saved on the device, so reloading or reopening the link drops you back in.
  - Practice mode: pass-and-play on one device, with testing tools.
- Hosting: Cloudflare Workers free plan (100k requests/day; each WebSocket message counts
  toward Durable Object usage, plenty for games among friends).

### Staying connected and away players
- The app pings the server every 20s and checks again the moment you return to the tab;
  if there's no answer it reconnects and rejoins your seat. The server drops sockets
  that go silent for 90s, so a sleeping phone shows as "away".
- Host away for a full minute: the host role passes to the next connected player.
- Current player away for a full minute: everyone else gets a dialog to **skip their turn**
  (anyone can) or **vote to remove them** (needs every other connected player). A removed
  player's seat and score are gone; if one player is left, they win.
- "It's your turn!" pops up for 3 seconds (tap to hide) when a turn comes to you.
- Sounds (synthesized, no files): dice rattle on rolls, chime on banks, bonk on crap-outs,
  a tick when play passes, and a three-note chime when it's your turn. On/off in ☰ menu.

### Voice chat
- "Join voice" in the lobby or the game (mic button in the top bar). Audio goes straight
  between browsers (WebRTC, everyone connects to everyone); the room's WebSocket only
  passes the set-up messages along, and `/api/ice` hands out connection servers.
- Mic badge next to each name while in voice; it ripples while that person talks
  (worked out on each device from the audio itself) and shows crossed out when muted.
- ☰ menu: voice on/off, microphone on/off, live mic level, and a volume slider for voices.
- Only STUN is set up, so some phones on cellular networks may not connect. To fix, create a
  TURN key in the Cloudflare dashboard (Realtime → TURN) and run:
  `npx wrangler secret put TURN_KEY_ID` and `npx wrangler secret put TURN_KEY_API_TOKEN`
  in `packages/server`. The worker then hands out short-lived TURN credentials automatically.

### Menu and host controls
- Everyone: sound effects on/off and volume, voice settings, rules, history, Leave game.
- Host: Restart game, Back to lobby, End game, each with a confirmation.
- No player count to choose: rooms take up to 5 and the host starts when everyone's in.

### Known gaps in online play
- Testing several players on one computer needs a different address per tab
  (localhost, 127.0.0.1, your network IP), since a seat is saved per site.

## Voice chat
WebRTC sends audio directly between players, so there's no media server to pay for.
The game's WebSocket handles the connection setup. Free public STUN servers handle most
connections. Some phones on cellular networks need a TURN relay, and free TURN tiers
cover a game this size. iOS needs a tap before the mic turns on, so there will be a
"Join voice" button, plus per-player mute.

## Build order
1. ~~Rules engine + tests~~ ✅
2. ~~Practice mode (pass-and-play)~~ ✅
3. ~~Server: rooms, lobby, turns, reconnects~~ ✅
4. ~~Online client: create/join, lobby, live game view~~ ✅
5. ~~Game-over screen~~ ✅
6. ~~Deploy (Cloudflare, dice.mjgibson.com)~~ ✅ Next: play a real game across phones
7. ~~Voice chat~~ ✅ (add a TURN key for cellular)
8. ~~Sounds, away players, host controls~~ ✅
9. Next: try a real game on phones; settle the open rule questions

## Development
```bash
npm install
npm run dev        # Cloudflare's local server (wrangler dev) on :8787 + app on http://localhost:5173
npm test           # rules + room tests
npm run typecheck
npm run deploy     # build the app and deploy to Cloudflare (needs `npx wrangler login` once)
```
