const socket = io();

let username = null;
let auctionId = new URLSearchParams(location.search).get("auction");
let item = null;
let bannerTimer = null;

const $ = (id) => document.getElementById(id);

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function inr(amount) {
  return `₹${Number(amount).toLocaleString("en-IN")}`;
}

function formatClock(seconds) {
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function toast(icon, title) {
  Swal.fire({ toast: true, position: "top-end", icon, title, showConfirmButton: false, timer: 2200 });
}

// short beeps with the Web Audio API -- no sound files needed
let audio = null;
function beep(freq, duration = 0.15, type = "sine") {
  try {
    audio = audio || new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.15, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + duration);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + duration);
  } catch (error) {
    // audio blocked -- visuals still work
  }
}

function showBanner(kind, text, ms = 4000) {
  const banner = $("banner");
  banner.className = `banner ${kind}`;
  banner.textContent = text;
  // restart the shake animation if a second alert lands quickly
  void banner.offsetWidth;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => banner.classList.add("hidden"), ms);
}

function renderLots(list) {
  $("lots").innerHTML = "";
  list.forEach((lot) => {
    const button = document.createElement("button");
    button.className = `lot${lot.id === auctionId ? " active" : ""}`;
    button.dataset.id = lot.id;
    const state = lot.status === "active" ? "LIVE" : lot.status;
    button.innerHTML = `<span class="emoji">${lot.image}</span>
      <span><div class="lot-title">${escapeHtml(lot.title)}</div>
      <div class="lot-meta">${inr(lot.currentBid)} · ${state}</div></span>`;
    button.addEventListener("click", () => joinAuction(lot.id));
    $("lots").appendChild(button);
  });
}

function renderHistory(history) {
  $("history").innerHTML = history.length ? "" : `<li class="muted">No bids yet. Be the first!</li>`;
  history.forEach((bid) => {
    const li = document.createElement("li");
    if (bid.bidder === username) li.classList.add("mine");
    li.innerHTML = `<span><span class="who">${escapeHtml(bid.bidder)}</span>
      <div class="when">${bid.timestamp} · ${formatClock(bid.timeRemaining)} left</div></span>
      <span class="amount">${inr(bid.amount)}</span>`;
    $("history").appendChild(li);
  });
}

function renderClock(seconds) {
  $("clock").textContent = formatClock(seconds);
  $("clock").classList.toggle("low", item && item.status === "active" && seconds < 15);
}

function renderStatus() {
  const open = item.status === "active";
  $("item-status").textContent = item.status;
  $("item-status").className = `pill ${item.status}`;
  document.querySelectorAll(".quick-btn, .bid-btn").forEach((button) => {
    button.disabled = !open;
  });
}

function renderPrice() {
  const minNext = item.currentBid + item.minIncrement;
  $("current-bid").textContent = inr(item.currentBid);
  $("leader").textContent = item.highestBidder || "no bids yet";
  $("min-next").textContent = `Minimum next bid: ${inr(minNext)}`;
  $("bid-amount").min = minNext;
  $("bid-amount").placeholder = inr(minNext);
  $("reserve").textContent =
    item.currentBid >= item.reservePrice && item.highestBidder ? "Reserve met ✓" : "Reserve not met";
  document.querySelectorAll(".quick-btn").forEach((button) => {
    const steps = Number(button.dataset.steps);
    button.textContent = `+${inr(item.minIncrement * steps)} → ${inr(item.currentBid + item.minIncrement * steps)}`;
  });
}

function flashTicker() {
  $("current-bid").classList.remove("flash");
  void $("current-bid").offsetWidth;
  $("current-bid").classList.add("flash");
}

function joinAuction(id) {
  auctionId = id;
  history.replaceState(null, "", `?auction=${id}`);
  socket.emit("auction:join", { auctionId: id, username });
}

function placeBid(amount) {
  if (!item) return;
  socket.emit("bid:place", { auctionId: item.id, amount });
}

document.querySelectorAll(".quick-btn").forEach((button) => {
  button.addEventListener("click", () => {
    placeBid(item.currentBid + item.minIncrement * Number(button.dataset.steps));
  });
});

$("bid-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const amount = Number($("bid-amount").value);
  if (!amount) return;
  placeBid(amount);
  $("bid-amount").value = "";
});

// ---- socket events ----
socket.on("connect", () => {
  $("status").textContent = "online";
  $("status").className = "status online";
  if (username && auctionId) joinAuction(auctionId);
});

socket.on("disconnect", () => {
  $("status").textContent = "offline";
  $("status").className = "status offline";
});

socket.on("auctions:update", ({ auctions }) => {
  renderLots(auctions);
  if (!auctionId && auctions.length) auctionId = auctions[0].id;
});

socket.on("auction:init", ({ item: data, bidHistory, timeRemaining, totalViewers, wallet }) => {
  item = data;
  $("item-image").textContent = item.image;
  $("item-title").textContent = item.title;
  $("item-desc").textContent = item.description;
  $("item-start").textContent = inr(item.startingPrice);
  $("item-step").textContent = inr(item.minIncrement);
  $("viewers").textContent = totalViewers;
  $("wallet-available").textContent = inr(wallet.available);
  renderPrice();
  renderStatus();
  renderClock(timeRemaining);
  renderHistory(bidHistory);
  document.querySelectorAll(".lot").forEach((node) => node.classList.toggle("active", node.dataset.id === item.id));
});

socket.on("auction:error", ({ message }) => {
  Swal.fire({ icon: "error", title: message }).then(askName);
});

socket.on("auction:time_tick", ({ auctionId: id, timeRemaining }) => {
  if (!item || id !== item.id) return;
  item.timeRemaining = timeRemaining;
  renderClock(timeRemaining);
  if (timeRemaining <= 5 && timeRemaining > 0) beep(880, 0.08, "square");
});

socket.on("user:joined", ({ totalViewers }) => {
  $("viewers").textContent = totalViewers;
});

socket.on("user:left", ({ totalViewers }) => {
  $("viewers").textContent = totalViewers;
});

socket.on("bid:success", ({ auctionId: id, currentBid, highestBidder, bidHistory, timeRemaining }) => {
  if (!item || id !== item.id) return;
  item.currentBid = currentBid;
  item.highestBidder = highestBidder;
  renderPrice();
  renderClock(timeRemaining);
  renderHistory(bidHistory);
  flashTicker();
  if (highestBidder === username) {
    beep(660);
    toast("success", `You lead at ${inr(currentBid)}`);
  } else {
    beep(440, 0.1);
  }
});

socket.on("bid:outbid", ({ message }) => {
  showBanner("outbid", `⚠️ ${message}`);
  beep(220, 0.35, "sawtooth");
});

socket.on("bid:rejected", ({ reason }) => {
  toast("error", reason);
});

socket.on("auction:extended", ({ auctionId: id, timeRemaining, message }) => {
  if (!item || id !== item.id) return;
  renderClock(timeRemaining);
  $("clock").classList.remove("bump");
  void $("clock").offsetWidth;
  $("clock").classList.add("bump");
  showBanner("extended", `⏱ ${message}`, 3000);
});

socket.on("auction:sold", ({ auctionId: id, winner, finalPrice }) => {
  if (!item || id !== item.id) return;
  item.status = "sold";
  renderStatus();
  renderClock(0);
  beep(523, 0.15);
  setTimeout(() => beep(784, 0.3), 160);
  Swal.fire({
    icon: winner === username ? "success" : "info",
    title: winner === username ? "You won! 🎉" : "SOLD!",
    text: `${item.title} sold to ${winner} for ${inr(finalPrice)}`,
  });
});

socket.on("auction:unsold", ({ auctionId: id, reason }) => {
  if (!item || id !== item.id) return;
  item.status = "unsold";
  renderStatus();
  renderClock(0);
  Swal.fire({ icon: "warning", title: "Not sold", text: reason });
});

socket.on("auction:reset", ({ auctionId: id }) => {
  if (item && id === item.id) joinAuction(id);
});

socket.on("wallet:update", ({ available }) => {
  $("wallet-available").textContent = inr(available);
});

async function askName() {
  const result = await Swal.fire({
    title: "Enter your bidder name",
    input: "text",
    inputPlaceholder: "e.g. Vikram",
    allowOutsideClick: false,
    confirmButtonText: "Enter the floor",
    inputValidator: (value) => (!value || !value.trim() ? "Name is required" : undefined),
  });
  username = result.value.trim().slice(0, 20);
  $("me").textContent = `👤 ${username}`;
  joinAuction(auctionId || "AUC_VINTAGE_99");
}

askName();
