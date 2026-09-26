# Real-Time Live Auction & Bidding Engine

Assignment 15 - Ashutosh Pawar (150096725130)

Live auction floor built with Express and Socket.io. Bidders enter with a
name, pick a lot and bid against each other in real time. The server is the
single source of truth: it validates every bid (auction still open, not
already the leader, at least the current bid + minimum increment, enough free
wallet balance), updates the price, broadcasts it to the room, and sends an
outbid alert only to the bidder who just lost the lead. Each lot has a
server-side countdown ticked to every screen once a second. A bid in the last
15 seconds resets the clock to 20 (anti-snipe), and at 0 the lot is sold if
the reserve price was met. Every bid is kept in an auditable history feed and
the room shows a live viewer count. The dark trading-floor UI in `public/`
has flash / shake animations and Web Audio beeps.


## Live demo

https://assignment-15-realtime-auction-platform-w0xm.onrender.com

Open it in two browser tabs (or on two devices) with different names to bid
against each other. The app runs as one Render web service on the free tier
(which supports WebSockets): the first visit after a period of inactivity can
take up to a minute, and auction state lives in memory, so it resets whenever
the server restarts. Deployed with root directory
`Ashutosh_Pawar_150096725130`, build `npm install`, start `npm start`; Render
provides `PORT`.

## Tech stack

- Node.js, Express 5
- Socket.io (server + browser client)
- dotenv, cors
- HTML + CSS + plain JS + SweetAlert2 for the frontend

## Project structure

```text
Ashutosh_Pawar_150096725130/
├── public/
│   ├── index.html          # lot tabs, item panel, bid controls, activity feed
│   ├── app.js              # socket handlers, bid buttons, banners, audio cues
│   └── style.css           # dark trading floor theme + animations
├── sockets/
│   ├── auctionEngine.js    # state, bid validation, outbid alerts, anti-snipe, wallets
│   └── timerManager.js     # server-side 1 s interval countdown per lot
├── .env.example
├── .gitignore
├── package.json
├── server.js               # Express, REST helpers, Socket.io bootstrap
└── README.md
```

## Setup

```bash
npm install
cp .env.example .env
npm run dev      # or: npm start
```

Open `http://localhost:5000` in a few tabs and enter a different bidder name
in each. A lot's clock starts when the first bidder walks onto it.

## Environment variables

| Variable                   | Required | Notes                                              |
| -------------------------- | :------: | -------------------------------------------------- |
| `PORT`                     |    no    | defaults to 5000                                   |
| `AUCTION_DURATION_SECONDS` |    no    | same length for every lot, e.g. `30` for a demo    |

## Lots

| Id               | Item                               | Start      | Step     | Reserve    | Length |
| ---------------- | ---------------------------------- | ---------- | -------- | ---------- | ------ |
| `AUC_VINTAGE_99` | 1967 Vintage Fender Stratocaster   | ₹50,000    | ₹2,000   | ₹56,000    | 90 s   |
| `AUC_WATCH_42`   | 1970 Omega Seamaster Automatic     | ₹80,000    | ₹5,000   | ₹90,000    | 120 s  |
| `AUC_BAT_83`     | Signed 1983 World Cup Cricket Bat  | ₹1,20,000  | ₹10,000  | ₹1,50,000  | 180 s  |

Room state per lot:

```js
{
  id, title, description, startingPrice, reservePrice, minIncrement,
  currentBid,            // starts at startingPrice
  highestBidder: null,   // { socketId, username }
  timeRemainingSeconds,
  status: "upcoming",    // upcoming -> active -> sold | unsold
  bidHistory: [],        // newest first: { id, bidder, amount, timestamp, timeRemaining }
  timerInterval: null
}
```

## Socket events

### Room & stream

| Event               | Direction        | Payload                                                          |
| ------------------- | ---------------- | ---------------------------------------------------------------- |
| `auction:join`      | client → server  | `{ auctionId, username }`                                        |
| `auction:init`      | server → client  | `{ item, bidHistory, timeRemaining, totalViewers, wallet }`      |
| `auction:time_tick` | server → room    | `{ auctionId, timeRemaining }` every second                      |
| `user:joined`       | server → room    | `{ username, totalViewers }`                                     |
| `user:left`         | server → room    | `{ username, totalViewers }`                                     |
| `auctions:update`   | server → all     | `{ auctions: [...] }` summary of every lot for the tabs          |
| `auction:error`     | server → client  | `{ message }` e.g. name already bidding in another tab           |

### Bidding

| Event              | Direction                   | Payload                                                                   |
| ------------------ | --------------------------- | ------------------------------------------------------------------------- |
| `bid:place`        | client → server             | `{ auctionId, amount }`                                                   |
| `bid:success`      | server → room               | `{ auctionId, newBid, currentBid, highestBidder, minNextBid, bidHistory, timeRemaining }` |
| `bid:outbid`       | server → previous leader    | `{ auctionId, message: "You have been outbid by Ananya at ₹54,000!" }`    |
| `bid:rejected`     | server → bidder             | `{ reason }`                                                              |
| `auction:extended` | server → room               | `{ auctionId, timeRemaining: 20, message }`                               |
| `auction:sold`     | server → room               | `{ auctionId, winner, finalPrice, status: "sold" }`                       |
| `auction:unsold`   | server → room               | `{ auctionId, status: "unsold", reason }` (no bids / reserve not met)     |
| `wallet:update`    | server → one bidder         | `{ balance, committed, available }`                                       |

## Bid validation (in order)

1. Lot must be `active` with time left → `Auction is closed`
2. Bidder must not already be the leader → `You are already the highest bidder`
3. Amount ≥ `currentBid + minIncrement` → `Bid too low. Minimum valid bid is ₹52,000`
4. Amount ≤ free wallet balance → `Insufficient funds`

Only then is the state changed, the room told, and the previous leader alerted.

**Race conditions:** Node runs one socket handler to the end before the next
one starts, and `handleBidPlacement` has no `await` in it. So when two people
send ₹54,000 at the same moment, the first one wins and the second is checked
against the new price and rejected (`Minimum valid bid is ₹56,000`). There is
no window where both can read the old price.

## Anti-snipe

If a bid lands with less than 15 s left, the clock is reset to 20 s and every
screen gets `auction:extended`. Snipers can't win by bidding in the last
second, because everyone else always gets 20 s to answer.

## Wallet simulation

Every new bidder gets ₹5,00,000 of play credit. While you lead a live lot, that
amount is held (`committed`) and can't be used on another lot. Being outbid
releases the hold. Winning deducts the final price from your balance.

## REST helpers

| Method | Route                       | Description                                   |
| ------ | --------------------------- | --------------------------------------------- |
| GET    | `/api/auctions`             | summary of all lots                           |
| POST   | `/api/auctions/:id/reset`   | re-list a finished lot (409 while it's live)  |

## Testing

1. Start the server (`AUCTION_DURATION_SECONDS=40 npm start` makes it faster).
2. Open three tabs: Vikram, Ananya, Viewer C.
3. Vikram bids: all three screens show ₹52,000 and Vikram as the leader.
4. Ananya bids higher: Vikram gets the red **outbid** banner and a buzz;
   the others do not.
5. When the clock is under 15 s, bid again: it jumps back to 0:20 and an
   anti-snipe banner shows on every screen.
6. Let it hit 0: everyone gets the SOLD popup, the buttons lock, and any
   further bid is rejected with `Auction is closed`.
7. `curl -X POST localhost:5000/api/auctions/AUC_VINTAGE_99/reset` to run it
   again.
