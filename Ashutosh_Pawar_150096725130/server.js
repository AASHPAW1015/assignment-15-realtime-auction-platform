require("dotenv").config({ quiet: true });

const express = require("express");
const cors = require("cors");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const { registerAuctionHandlers, listAuctions, resetAuction } = require("./sockets/auctionEngine");

const app = express();

app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.get("/api/auctions", (request, response) => {
  response.status(200).json({ auctions: listAuctions() });
});

// re-list a finished auction so the demo can be run again
app.post("/api/auctions/:id/reset", (request, response) => {
  const result = resetAuction(io, request.params.id);
  if (result === null) {
    return response.status(404).json({ message: "Auction not found" });
  }
  if (result === false) {
    return response.status(409).json({ message: "Auction is still running" });
  }
  return response.status(200).json({ message: "Auction reset", auction: result });
});

io.on("connection", (socket) => {
  console.log(`socket connected: ${socket.id}`);
  registerAuctionHandlers(io, socket);
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`auction server is running on port ${PORT}!!`);
});
