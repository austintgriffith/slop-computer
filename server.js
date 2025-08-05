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

// Generate server URL
const serverUrl = `http://${localIp}:${PORT}`;

// Serve static files from the current directory
app.use(express.static(path.join(__dirname)));

// Inject socket.io client to HTML files
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Secret endpoint to reset messages
app.get("/supersecretreset", (req, res) => {
  // Reset messages
  messages = [];
  
  // Broadcast updated messages to all connected clients
  io.emit("messageUpdate", messages);
  
  console.log("Messages have been reset via /supersecretreset endpoint");
  
  res.json({
    success: true,
    message: "All messages have been reset! 🔄",
    messageCount: messages.length
  });
});

// Admin endpoint to get all messages
app.get("/messages", (req, res) => {
  res.json({
    messages: messages,
    count: messages.length
  });
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

// Message storage - in production, you'd want to use a proper database
let messages = [];

// Rate limiting storage
const rateLimits = {};
const RATE_LIMIT_WINDOW = 30000; // 30 seconds
const MAX_MESSAGES_PER_WINDOW = 3;

// Helper function to clean old rate limit entries
function cleanupRateLimit() {
  const now = Date.now();
  Object.keys(rateLimits).forEach(ip => {
    rateLimits[ip] = rateLimits[ip].filter(timestamp => 
      now - timestamp < RATE_LIMIT_WINDOW
    );
    if (rateLimits[ip].length === 0) {
      delete rateLimits[ip];
    }
  });
}

// Clean up rate limits every minute
setInterval(cleanupRateLimit, 60000);

// Message validation
function validateMessage(messageData) {
  if (!messageData.name || typeof messageData.name !== 'string') {
    return { valid: false, error: 'Name is required' };
  }
  
  if (!messageData.message || typeof messageData.message !== 'string') {
    return { valid: false, error: 'Message is required' };
  }
  
  if (messageData.name.trim().length === 0) {
    return { valid: false, error: 'Name cannot be empty' };
  }
  
  if (messageData.message.trim().length === 0) {
    return { valid: false, error: 'Message cannot be empty' };
  }
  
  if (messageData.name.length > 50) {
    return { valid: false, error: 'Name must be 50 characters or less' };
  }
  
  if (messageData.message.length > 500) {
    return { valid: false, error: 'Message must be 500 characters or less' };
  }
  
  // Basic profanity filter (you can expand this)
  const prohibitedWords = ['spam', 'test123', 'admin', 'root'];
  const lowerMessage = messageData.message.toLowerCase();
  const lowerName = messageData.name.toLowerCase();
  
  for (const word of prohibitedWords) {
    if (lowerMessage.includes(word) || lowerName.includes(word)) {
      return { valid: false, error: 'Message contains prohibited content' };
    }
  }
  
  return { valid: true };
}

// Rate limiting check
function checkRateLimit(ip) {
  if (!rateLimits[ip]) {
    rateLimits[ip] = [];
  }
  
  const now = Date.now();
  // Remove old timestamps
  rateLimits[ip] = rateLimits[ip].filter(timestamp => 
    now - timestamp < RATE_LIMIT_WINDOW
  );
  
  return rateLimits[ip].length < MAX_MESSAGES_PER_WINDOW;
}

// Add timestamp to rate limit
function addToRateLimit(ip) {
  if (!rateLimits[ip]) {
    rateLimits[ip] = [];
  }
  rateLimits[ip].push(Date.now());
}

io.on("connection", (socket) => {
  console.log("A client connected");
  onlineUsers++;

  // Generate a unique ID for this user if they don't provide one
  const userId =
    socket.handshake.query.userId ||
    `user-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Get client IP
  const clientIp = socket.handshake.address;

  // Store user information
  connectedUsers[socket.id] = {
    id: userId,
    socketId: socket.id,
    ip: clientIp,
    userAgent: socket.handshake.headers["user-agent"],
    connectedAt: new Date(),
    lastActivity: new Date(),
  };

  // Broadcast the updated user count to all clients
  io.emit("userCount", onlineUsers);

  // Send the user their ID
  socket.emit("userId", userId);

  // Send current messages to new connection
  socket.emit("messageUpdate", messages);

  // Handle message retrieval request
  socket.on("getMessages", () => {
    socket.emit("messageUpdate", messages);
  });

  // Handle message posting
  socket.on("postMessage", (messageData) => {
    console.log("Message post attempt from", userId, ":", messageData);
    
    // Check rate limit
    if (!checkRateLimit(clientIp)) {
      socket.emit("messageError", "Too many messages! Please wait before posting again.");
      console.log(`Rate limit exceeded for ${clientIp}`);
      return;
    }
    
    // Validate message
    const validation = validateMessage(messageData);
    if (!validation.valid) {
      socket.emit("messageError", validation.error);
      console.log(`Message validation failed for ${userId}: ${validation.error}`);
      return;
    }
    
    // Create message object
    const message = {
      id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      name: messageData.name.trim(),
      message: messageData.message.trim(),
      timestamp: new Date().toISOString(),
      userId: userId,
      ip: clientIp
    };
    
    // Add message to storage
    messages.push(message);
    
    // Keep only the last 100 messages to prevent memory issues
    if (messages.length > 100) {
      messages = messages.slice(-100);
    }
    
    // Add to rate limit tracking
    addToRateLimit(clientIp);
    
    // Broadcast new message to all clients
    io.emit("messageUpdate", messages);
    
    // Confirm to sender
    socket.emit("messagePosted", message);
    
    console.log(`Message posted by ${userId} (${message.name}): ${message.message}`);
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

// Add some initial sample messages
if (messages.length === 0) {
  messages.push({
    id: 'sample-1',
    name: 'System Administrator',
    message: 'Welcome to the Win95 Message Board! This is a nostalgic throwback to the good old days of computing. 💾',
    timestamp: new Date(Date.now() - 120000).toISOString(),
    userId: 'system',
    ip: 'localhost'
  });
  
  messages.push({
    id: 'sample-2',
    name: 'Clippy',
    message: 'It looks like you\'re trying to post a message! Would you like help with that? 📎',
    timestamp: new Date(Date.now() - 60000).toISOString(),
    userId: 'clippy',
    ip: 'localhost'
  });
}

// Start the server
server.listen(PORT, localIp, () => {
  console.log(`Server running at http://${localIp}:${PORT}/`);
  console.log(`You can also access it at http://localhost:${PORT}/`);
  console.log(`Admin endpoints:`);
  console.log(`  - Messages: http://${localIp}:${PORT}/messages`);
  console.log(`  - Reset: http://${localIp}:${PORT}/supersecretreset`);

  // Create QR code for console
  console.log("\nAccess the server using the URL above.");
  console.log("\nServer QR Code:");
  qrcode.generate(serverUrl, { small: true });
  
  console.log(`\nMessage Board is ready! Currently ${messages.length} messages in memory.`);
});