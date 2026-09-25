const crypto = require("crypto");
const { startTimer, stopTimer } = require("./timerManager");

const SNIPE_WINDOW_SECONDS = 15; // a bid with less than this left...
const EXTEND_TO_SECONDS = 20; // ...resets the clock to this
const STARTING_WALLET = 500000; // simulated credit every new bidder gets

const CATALOG = [
  {
    id: "AUC_VINTAGE_99",
    title: "1967 Vintage Fender Stratocaster",
    description: "Original condition rare electric guitar, sunburst finish",
    image: "🎸",
    startingPrice: 50000,
    reservePrice: 56000,
    minIncrement: 2000,
    durationSeconds: 90,
  },
  {
    id: "AUC_WATCH_42",
    title: "1970 Omega Seamaster Automatic",
    description: "Serviced 2025, original dial and bracelet",
    image: "⌚",
    startingPrice: 80000,
    reservePrice: 90000,
    minIncrement: 5000,
    durationSeconds: 120,
  },
  {
    id: "AUC_BAT_83",
    title: "Signed 1983 World Cup Cricket Bat",
    description: "Autographed by the winning squad, with certificate",
    image: "🏏",
    startingPrice: 120000,
    reservePrice: 150000,
    minIncrement: 10000,
    durationSeconds: 180,
  },
];

// In-memory auction room state, keyed by id
const auctions = {};
const wallets = {}; // username (lowercase) -> balance
const online = {}; // username (lowercase) -> socketId

// AUCTION_DURATION_SECONDS in .env overrides every lot's length (quick demos)
function freshAuction(item) {
  const durationSeconds = Number(process.env.AUCTION_DURATION_SECONDS) || item.durationSeconds;
  return {
    ...item,
    durationSeconds,
    currentBid: item.startingPrice,
    highestBidder: null, // { socketId, username }
    timeRemainingSeconds: durationSeconds,
    status: "upcoming", // "upcoming" -> "active" -> "sold" | "unsold"
    bidHistory: [],
    timerInterval: null,
  };
}

CATALOG.forEach((item) => {
  auctions[item.id] = freshAuction(item);
});

function key(username) {
  return String(username).toLowerCase();
}

// what clients may see (no interval handle, no socket ids)
function publicItem(auction) {
  return {
    id: auction.id,
    title: auction.title,
    description: auction.description,
    image: auction.image,
    startingPrice: auction.startingPrice,
    reservePrice: auction.reservePrice,
    currentBid: auction.currentBid,
    minIncrement: auction.minIncrement,
    minNextBid: auction.currentBid + auction.minIncrement,
    highestBidder: auction.highestBidder ? auction.highestBidder.username : null,
    timeRemaining: auction.timeRemainingSeconds,
    status: auction.status,
    totalBids: auction.bidHistory.length,
  };
}

function listAuctions() {
  return Object.values(auctions).map(publicItem);
}

function viewerCount(io, auctionId) {
  const room = io.sockets.adapter.rooms.get(auctionId);
  return room ? room.size : 0;
}

// money tied up as the current top bid on OTHER live auctions
function committedFunds(username, exceptAuctionId) {
  return Object.values(auctions)
    .filter(
      (a) =>
        a.id !== exceptAuctionId &&
        a.status === "active" &&
        a.highestBidder &&
        key(a.highestBidder.username) === key(username),
    )
    .reduce((sum, a) => sum + a.currentBid, 0);
}

function walletInfo(username) {
  const balance = wallets[key(username)] ?? STARTING_WALLET;
  const committed = committedFunds(username, null);
  return { balance, committed, available: balance - committed };
}

function sendWallet(io, username) {
  const socketId = online[key(username)];
  if (socketId) io.to(socketId).emit("wallet:update", walletInfo(username));
}

function formatINR(amount) {
  return `₹${Number(amount).toLocaleString("en-IN")}`;
}

function closeAuction(io, auction) {
  stopTimer(auction);
  const winner = auction.highestBidder;
  const reserveMet = winner && auction.currentBid >= auction.reservePrice;

  if (reserveMet) {
    auction.status = "sold";
    wallets[key(winner.username)] = walletInfo(winner.username).balance - auction.currentBid;
    io.to(auction.id).emit("auction:sold", {
      auctionId: auction.id,
      winner: winner.username,
      finalPrice: auction.currentBid,
      status: "sold",
    });
    sendWallet(io, winner.username);
  } else {
    auction.status = "unsold";
    io.to(auction.id).emit("auction:unsold", {
      auctionId: auction.id,
      status: "unsold",
      reason: winner ? `Reserve of ${formatINR(auction.reservePrice)} not met` : "No bids were placed",
    });
    if (winner) sendWallet(io, winner.username); // their hold is released
  }
  io.emit("auctions:update", { auctions: listAuctions() });
}

function activate(io, auction) {
  if (auction.status !== "upcoming") return;
  auction.status = "active";
  startTimer(io, auction, (ended) => closeAuction(io, ended));
  io.emit("auctions:update", { auctions: listAuctions() });
}

function handleBidPlacement(io, socket, auction, bidAmount, username) {
  // Node runs this handler start to finish before touching the next bid, so
  // two bids can never both read the same currentBid: the second one is
  // always validated against the first one's result.

  // 1. Check if auction is active
  if (auction.status !== "active" || auction.timeRemainingSeconds <= 0) {
    return socket.emit("bid:rejected", { reason: "Auction is closed" });
  }

  // 2. Check if bidder is already the highest bidder
  if (auction.highestBidder && key(auction.highestBidder.username) === key(username)) {
    return socket.emit("bid:rejected", { reason: "You are already the highest bidder" });
  }

  // 3. Check minimum increment
  const minimumRequired = auction.currentBid + auction.minIncrement;
  if (!Number.isInteger(bidAmount) || bidAmount < minimumRequired) {
    return socket.emit("bid:rejected", {
      reason: `Bid too low. Minimum valid bid is ${formatINR(minimumRequired)}`,
    });
  }

  // 4. Wallet check: can't bid more than you have free
  const available = walletInfo(username).balance - committedFunds(username, auction.id);
  if (bidAmount > available) {
    return socket.emit("bid:rejected", {
      reason: `Insufficient funds. Available balance is ${formatINR(available)}`,
    });
  }

  // 5. Capture previous highest bidder to notify outbid
  const previousBidder = auction.highestBidder;

  // 6. Update state
  auction.currentBid = bidAmount;
  auction.highestBidder = { socketId: socket.id, username };
  auction.bidHistory.unshift({
    id: crypto.randomUUID(),
    bidder: username,
    amount: bidAmount,
    timestamp: new Date().toLocaleTimeString("en-IN", { hour12: false }),
    timeRemaining: auction.timeRemainingSeconds,
  });

  // 7. Anti-snipe rule: a bid in the final seconds resets the clock
  if (auction.timeRemainingSeconds < SNIPE_WINDOW_SECONDS) {
    auction.timeRemainingSeconds = EXTEND_TO_SECONDS;
    io.to(auction.id).emit("auction:extended", {
      auctionId: auction.id,
      timeRemaining: EXTEND_TO_SECONDS,
      message: `Anti-snipe triggered: bid in the final seconds, clock reset to ${EXTEND_TO_SECONDS}s!`,
    });
  }

  // 8. Broadcast new top bid to the room
  io.to(auction.id).emit("bid:success", {
    auctionId: auction.id,
    newBid: auction.currentBid,
    currentBid: auction.currentBid,
    highestBidder: username,
    minNextBid: auction.currentBid + auction.minIncrement,
    bidHistory: auction.bidHistory,
    timeRemaining: auction.timeRemainingSeconds,
  });

  // 9. Private alert to the outbid user only (their latest socket)
  if (previousBidder && key(previousBidder.username) !== key(username)) {
    const target = online[key(previousBidder.username)] || previousBidder.socketId;
    io.to(target).emit("bid:outbid", {
      auctionId: auction.id,
      message: `You have been outbid by ${username} at ${formatINR(bidAmount)}!`,
    });
    sendWallet(io, previousBidder.username); // their hold is released
  }

  sendWallet(io, username);
  io.emit("auctions:update", { auctions: listAuctions() });
}

function leaveAuction(io, socket) {
  const auctionId = socket.data.auctionId;
  if (!auctionId) return;
  socket.leave(auctionId);
  socket.data.auctionId = null;
  io.to(auctionId).emit("user:left", {
    username: socket.data.username,
    totalViewers: viewerCount(io, auctionId),
  });
}

function registerAuctionHandlers(io, socket) {
  socket.emit("auctions:update", { auctions: listAuctions() });

  socket.on("auction:join", ({ auctionId, username } = {}) => {
    const auction = auctions[auctionId];
    const name = String(username ?? socket.data.username ?? "").trim().slice(0, 20);
    if (!auction) return socket.emit("bid:rejected", { reason: "Auction not found" });
    if (!name) return socket.emit("bid:rejected", { reason: "Enter a username" });

    const holder = online[key(name)];
    if (holder && holder !== socket.id && io.sockets.sockets.has(holder)) {
      return socket.emit("auction:error", { message: `"${name}" is already bidding from another tab` });
    }
    online[key(name)] = socket.id;
    socket.data.username = name;

    if (socket.data.auctionId !== auctionId) {
      leaveAuction(io, socket);
      socket.join(auctionId);
      socket.data.auctionId = auctionId;
    }

    // the clock starts when the first bidder walks onto the floor
    activate(io, auction);

    socket.emit("auction:init", {
      item: publicItem(auction),
      bidHistory: auction.bidHistory,
      timeRemaining: auction.timeRemainingSeconds,
      totalViewers: viewerCount(io, auctionId),
      wallet: walletInfo(name),
      username: name,
    });
    io.to(auctionId).emit("user:joined", { username: name, totalViewers: viewerCount(io, auctionId) });
  });

  socket.on("bid:place", ({ auctionId, amount } = {}) => {
    const auction = auctions[auctionId];
    const username = socket.data.username;
    if (!auction || !username || socket.data.auctionId !== auctionId) {
      return socket.emit("bid:rejected", { reason: "Join this auction before bidding" });
    }
    handleBidPlacement(io, socket, auction, Number(amount), username);
  });

  socket.on("disconnect", () => {
    leaveAuction(io, socket);
    const name = socket.data.username;
    if (name && online[key(name)] === socket.id) delete online[key(name)];
  });
}

// put a finished auction back on the block (demo helper)
function resetAuction(io, auctionId) {
  const auction = auctions[auctionId];
  if (!auction) return null;
  if (auction.status === "active") return false;

  const item = CATALOG.find((entry) => entry.id === auctionId);
  auctions[auctionId] = freshAuction(item);
  const fresh = auctions[auctionId];
  io.to(auctionId).emit("auction:reset", { auctionId });
  if (viewerCount(io, auctionId) > 0) activate(io, fresh);
  io.emit("auctions:update", { auctions: listAuctions() });
  return publicItem(fresh);
}

module.exports = {
  auctions,
  listAuctions,
  handleBidPlacement,
  registerAuctionHandlers,
  resetAuction,
};
