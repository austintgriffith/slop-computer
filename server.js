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

// Modify index.html to include socket.io code and QR code
let htmlContent = fs.readFileSync("index.html", "utf8");

// Only inject the script if it's not already there
if (!htmlContent.includes("socket.io")) {
  // Find the position to inject before the closing body tag
  const bodyClosePos = htmlContent.lastIndexOf("</body>");

  if (bodyClosePos !== -1) {
    const scriptToInject = `
    <script src="/socket.io/socket.io.js"></script>
    <script>
        const socket = io();
        
        // Get user ID from URL or generate one
        const urlParams = new URLSearchParams(window.location.search);
        const userId = urlParams.get('userId') || localStorage.getItem('userId');
        
        // Connect with user ID if available
        if (userId) {
            socket.io.opts.query = { userId };
        }
        
        // Store user ID when received from server
        socket.on('userId', (id) => {
            localStorage.setItem('userId', id);
        });
        
        socket.on('reload', () => {
            console.log('Reloading page...');
            window.location.reload();
        });
        
        // Handle disconnection events
        socket.on('disconnect', () => {
            console.log('Disconnected from server, will reload in 1 second...');
            setTimeout(() => {
                window.location.reload();
            }, 1000);
        });
        
        // Send periodic pings to update last activity
        setInterval(() => {
            socket.emit('ping');
        }, 30000);
    </script>
`;

    // Insert the script before the closing body tag
    htmlContent =
      htmlContent.substring(0, bodyClosePos) +
      scriptToInject +
      htmlContent.substring(bodyClosePos);

    // Write the modified content back to the file
    fs.writeFileSync("index.html", htmlContent);
    console.log("Added auto-reload script to index.html");
  }
}

// Start the server
server.listen(PORT, localIp, () => {
  console.log(`Server running at http://${localIp}:${PORT}/`);
  console.log(`You can also access it at http://localhost:${PORT}/`);

  // Create QR code for console
  console.log("\nAccess the server using the URL above.");
  console.log("\nServer QR Code:");
  qrcode.generate(serverUrl, { small: true });
});
