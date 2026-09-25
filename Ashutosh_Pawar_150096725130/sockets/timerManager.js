// Server-side countdown. One setInterval per live auction ticks the clock down
// and broadcasts it, so every bidder sees the same number no matter how slow
// or fast their own machine is.
function startTimer(io, auction, onEnd) {
  stopTimer(auction);

  auction.timerInterval = setInterval(() => {
    auction.timeRemainingSeconds = Math.max(0, auction.timeRemainingSeconds - 1);
    io.to(auction.id).emit("auction:time_tick", {
      auctionId: auction.id,
      timeRemaining: auction.timeRemainingSeconds,
    });

    if (auction.timeRemainingSeconds <= 0) {
      stopTimer(auction);
      onEnd(auction);
    }
  }, 1000);
}

function stopTimer(auction) {
  if (auction.timerInterval) {
    clearInterval(auction.timerInterval);
    auction.timerInterval = null;
  }
}

module.exports = { startTimer, stopTimer };
