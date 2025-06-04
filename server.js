const express = require("express");
const path = require("path");
const os = require("os");
const fs = require("fs");
const chokidar = require("chokidar");
const http = require("http");
const socketIo = require("socket.io");
const qrcode = require("qrcode-terminal");

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Get local IP address
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip over non-IPv4 and internal (loopback) addresses
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1"; // Default to localhost if no external IP found
}

const localIp = getLocalIp();
const PORT = 3000;

// Generate server URL (still needed for console output)
const serverUrl = `http://${localIp}:${PORT}`;

// Store voting results
let voteResults = {
  good: 0,
  bad: 0,
};

// Store which users have voted to prevent duplicate votes
let votedUsers = new Set();

// Serve static files from the current directory
app.use(express.static(path.join(__dirname)));

// Inject socket.io client to HTML files
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Set up file watcher
const watcher = chokidar.watch("index.html", {
  ignored: /(^|[\/\\])\../, // ignore dotfiles
  persistent: true,
});

// When index.html changes, notify all clients
watcher.on("change", (path) => {
  console.log(`File ${path} has been changed`);
  io.emit("reload");
});

// Socket.io connection
let onlineUsers = 0;
// Store connected users with details
let connectedUsers = {};

io.on("connection", (socket) => {
  console.log("A client connected");
  onlineUsers++;

  // Generate a unique ID for this user if they don't provide one
  const userId =
    socket.handshake.query.userId ||
    `user-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Store user information
  connectedUsers[socket.id] = {
    id: userId,
    socketId: socket.id,
    ip: socket.handshake.address,
    userAgent: socket.handshake.headers["user-agent"],
    connectedAt: new Date(),
    lastActivity: new Date(),
  };

  // Broadcast the updated user count to all clients
  io.emit("userCount", onlineUsers);

  // Send the user their ID
  socket.emit("userId", userId);

  // Send current vote results to the new client
  socket.emit("voteResults", voteResults);

  // Handle voting
  socket.on("vote", (choice) => {
    // Check if this user has already voted
    if (votedUsers.has(userId)) {
      console.log(`User ${userId} tried to vote again, ignoring`);
      return;
    }

    // Validate vote choice
    if (choice !== "good" && choice !== "bad") {
      console.log(`Invalid vote choice: ${choice}`);
      return;
    }

    // Record the vote
    voteResults[choice]++;
    votedUsers.add(userId);

    console.log(`User ${userId} voted: ${choice}`);
    console.log(
      `Current results: Good=${voteResults.good}, Bad=${voteResults.bad}`
    );

    // Broadcast updated results to all clients
    io.emit("voteResults", voteResults);
  });

  // Update user status when they send a ping
  socket.on("ping", () => {
    if (connectedUsers[socket.id]) {
      connectedUsers[socket.id].lastActivity = new Date();
    }
  });

  socket.on("disconnect", () => {
    console.log("A client disconnected");
    onlineUsers--;

    // Remove user from connected users
    delete connectedUsers[socket.id];

    // Broadcast the updated user count to all clients
    io.emit("userCount", onlineUsers);
  });
});

// Start the server
server.listen(PORT, localIp, () => {
  console.log(`Server running at http://${localIp}:${PORT}/`);
  console.log(`You can also access it at http://localhost:${PORT}/`);

  // Create QR code for console
  console.log("\nAccess the server using the URL above.");
  console.log("\nServer QR Code:");
  qrcode.generate(serverUrl, { small: true });

  console.log("\n🗳️  Voting App: How's the vibe?");
  console.log("📊 Vote results will be logged here as they come in...\n");
});
