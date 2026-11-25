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
  would push over 10,000.

### Winning
- First to score **exactly 10,000** wins.
- You can't set aside dice that would take you over 10,000. If every scoring choice
  in a roll would go over, it counts as a crap-out.

### Open questions
1. **Two 5s at 9,950:** the example says rolling two 5s when you need 50 ends the turn.
   The current build lets you set aside just one 5 and win, same as any other turn.
   Which is right?
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
- `packages/server`: Node + WebSockets (`ws`). The server holds every game and rolls the
  dice (crypto-random), so nobody can cheat from their browser.
  - `room.ts`: seats, lobby, host, turns, the 5-second turn-over pause. No sockets, unit-tested.
  - `index.ts`: WebSocket at `/ws`, room codes, reconnects, cleanup of empty rooms after
    30 minutes. In production it also serves the built client, so one service runs everything.
- `packages/client`: Vite + React, mobile-first.
  - Home: create a game (pick 2–5 players), join with a code, or practice.
  - `/room/CODE`: join form (for invite links), lobby with share button, live game, end screen.
  - Everyone sees every roll, every die the current player taps, banks and crap-outs live.
  - Your seat is saved on the device, so reloading or reopening the link drops you back in.
  - Practice mode: pass-and-play on one device, with testing tools.
- Hosting: one Railway service for the app and server (about $5/month), or Cloudflare
  Durable Objects for $0 with more setup.

### Known gaps in online play
- If the current player leaves or drops for good, the game waits for them. Needs a way
  to skip an away player (e.g. auto-skip after a minute, or host can skip).
- Rooms live in server memory: a server restart ends games in progress.
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
6. Deploy and play across real phones
7. Voice chat
8. Polish: animations, sound, haptics; skipping away players

## Development
```bash
npm install
npm run dev        # game server on :8787 + app on http://localhost:5173
npm test           # rules + room tests
npm run typecheck
npm run build && npm start   # production: one server on $PORT serving app + /ws
```
