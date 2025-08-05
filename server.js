const express = require("express");
const path = require("path");
const os = require("os");
const fs = require("fs");
const chokidar = require("chokidar");
const http = require("http");
const socketIo = require("socket.io");
const QRCode = require("qrcode");
const { v4: uuidv4 } = require('uuid');

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

// Generate QR code for server URL
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

// Game variables
const GAME_CONFIG = {
  boardWidth: 20,
  boardHeight: 20,
  mineCount: 15,
  roundDuration: 30, // seconds
  endRoundDelay: 10, // seconds to display results
  preparingDelay: 5, // seconds to show initial state before round starts
  playerSpeed: 0.2, // grid cells per update
  updateInterval: 100, // ms between game updates
  powerupCount: 12,
  powerupSpawnInterval: 3,
  cashBonusAmount: 50, // points for collecting cash
  lastManStandingBonus: 200, // bonus points for being the last player alive
  explosionAnimTime: 1.5, // seconds for explosion animation to complete
  
  // Wandering behavior settings
  wanderChangeDirChance: 0.05, // 5% chance per update to change direction
  wanderMaxTurn: Math.PI / 4, // Maximum turn angle (45 degrees)
  wanderMinMoveTime: 10, // Minimum time to move in one direction (in updates)
  wanderPauseChance: 0.01, // 1% chance to pause
  wanderPauseDuration: [3, 15], // Range of pause duration in updates
};

const players = {};
const scores = {};
const playerData = {}; // Store persistent player data
let mines = [];
let powerups = [];
let gameState = "waiting"; // waiting, preparing, playing, roundEnd
let roundNumber = 1;
let roundTimer = 0;
let stateTimer = 0;
let powerupTimer = 0;
let gameInterval = null;
let playerEmojis = ["🐱", "🐶", "🐭", "🦊", "🐻", "🐼", "🐨", "🐯", "🦁", "🐮", "🐷", "🐸", "🐵", "🐧", "🦄", "🐺", "🐰", "🦔", "🐹", "🐙", "🐢", "🦆", "🐛", "🦋"];

// Helper function to create a new mine
function createMine() {
  return {
    x: Math.floor(Math.random() * GAME_CONFIG.boardWidth),
    y: Math.floor(Math.random() * GAME_CONFIG.boardHeight),
  };
}

// Generate mines for the game
function generateMines() {
  mines = [];
  for (let i = 0; i < GAME_CONFIG.mineCount; i++) {
    let mine;
    do {
      mine = createMine();
      // Check if this position already has a mine
    } while (mines.some(m => m.x === mine.x && m.y === mine.y));
    mines.push(mine);
  }
}

// Check if position has a mine
function hasMine(x, y) {
  return mines.some(mine => {
    // Use a radius check for collision
    const dx = mine.x - x;
    const dy = mine.y - y;
    return Math.sqrt(dx*dx + dy*dy) < 0.5; // Collision if within 0.5 cell
  });
}

// Helper function to create a new powerup
function createPowerup() {
  const powerupTypes = [
    { emoji: "💵", value: GAME_CONFIG.cashBonusAmount, weight: 3 },
    { emoji: "💰", value: GAME_CONFIG.cashBonusAmount * 2, weight: 2 },
    { emoji: "💎", value: GAME_CONFIG.cashBonusAmount * 3, weight: 1 },
  ];
  
  // Calculate total weight for weighted random selection
  const totalWeight = powerupTypes.reduce((sum, type) => sum + type.weight, 0);
  let random = Math.random() * totalWeight;
  
  // Select a powerup type based on weight
  let selectedType;
  for (const type of powerupTypes) {
    random -= type.weight;
    if (random <= 0) {
      selectedType = type;
      break;
    }
  }
  
  return {
    x: Math.random() * GAME_CONFIG.boardWidth,
    y: Math.random() * GAME_CONFIG.boardHeight,
    type: selectedType.emoji,
    value: selectedType.value
  };
}

// Generate initial powerups for the game
function generatePowerups() {
  powerups = [];
  for (let i = 0; i < GAME_CONFIG.powerupCount; i++) {
    let powerup;
    do {
      powerup = createPowerup();
      // Check if this position already has a mine or another powerup
    } while (
      mines.some(m => Math.sqrt(Math.pow(m.x - powerup.x, 2) + Math.pow(m.y - powerup.y, 2)) < 1) ||
      powerups.some(p => Math.sqrt(Math.pow(p.x - powerup.x, 2) + Math.pow(p.y - powerup.y, 2)) < 1)
    );
    powerups.push(powerup);
  }
}

// Create a new player or restore existing one
function createOrRestorePlayer(socketId, persistentId = null) {
  // If we have persistent ID and that player exists in our records
  if (persistentId && playerData[persistentId]) {
    const data = playerData[persistentId];
    
    // Update with new socket ID
    data.socketId = socketId;
    
    // Create player with same emoji and score
    players[socketId] = {
      id: socketId,
      persistentId: persistentId,
      emoji: data.emoji,
      x: Math.random() * GAME_CONFIG.boardWidth,
      y: Math.random() * GAME_CONFIG.boardHeight,
      alive: true,
      directionX: Math.random() * 2 - 1,
      directionY: Math.random() * 2 - 1,
      moveTimer: Math.floor(Math.random() * GAME_CONFIG.wanderMinMoveTime) + GAME_CONFIG.wanderMinMoveTime,
      isPaused: false,
      pauseTimer: 0,
      frozen: gameState !== "playing"
    };
    
    // Restore their previous score
    scores[socketId] = data.score || 0;
    
    return persistentId;
  } 
  
  // Otherwise create a new player
  const emojiIndex = Math.floor(Math.random() * playerEmojis.length);
  const playerEmoji = playerEmojis[emojiIndex];
  
  // Create a persistent ID
  const newPersistentId = persistentId || uuidv4();
  
  // Store in our records
  playerData[newPersistentId] = {
    socketId: socketId,
    emoji: playerEmoji,
    score: 0
  };
  
  // Create player
  players[socketId] = {
    id: socketId,
    persistentId: newPersistentId,
    emoji: playerEmoji,
    x: Math.random() * GAME_CONFIG.boardWidth,
    y: Math.random() * GAME_CONFIG.boardHeight,
    alive: true,
    directionX: Math.random() * 2 - 1,
    directionY: Math.random() * 2 - 1,
    moveTimer: Math.floor(Math.random() * GAME_CONFIG.wanderMinMoveTime) + GAME_CONFIG.wanderMinMoveTime,
    isPaused: false,
    pauseTimer: 0,
    frozen: gameState !== "playing"
  };
  
  // Initialize player score
  scores[socketId] = 0;
  
  return newPersistentId;
}

// Start a new round
function startNewRound() {
  // Enter preparing state first
  gameState = "preparing";
  stateTimer = GAME_CONFIG.preparingDelay;
  
  // Generate game elements
  generateMines();
  generatePowerups();
  
  // Reset player positions and alive status
  Object.keys(players).forEach(id => {
    const player = players[id];
    player.x = Math.random() * GAME_CONFIG.boardWidth;
    player.y = Math.random() * GAME_CONFIG.boardHeight;
    player.alive = true;
    
    // Initialize direction with random angle
    const angle = Math.random() * 2 * Math.PI;
    player.directionX = Math.cos(angle);
    player.directionY = Math.sin(angle);
    
    // Add wandering state properties
    player.moveTimer = Math.floor(Math.random() * GAME_CONFIG.wanderMinMoveTime) + GAME_CONFIG.wanderMinMoveTime;
    player.isPaused = false;
    player.pauseTimer = 0;
    
    // Freeze players initially - they won't move during preparing phase
    player.frozen = true;
  });
  
  // Send game state to all clients
  io.emit("gameState", {
    gameState,
    players,
    mines,
    powerups,
    roundNumber,
    roundTimer: GAME_CONFIG.roundDuration,
    stateTimer,
    boardWidth: GAME_CONFIG.boardWidth,
    boardHeight: GAME_CONFIG.boardHeight
  });
}

// Begin active gameplay after preparation
function startPlaying() {
  gameState = "playing";
  roundTimer = GAME_CONFIG.roundDuration;
  powerupTimer = GAME_CONFIG.powerupSpawnInterval;
  
  // Unfreeze all players
  Object.keys(players).forEach(id => {
    players[id].frozen = false;
  });
  
  // Send game state to all clients
  io.emit("gameState", {
    gameState,
    players,
    roundTimer,
    roundNumber,
    boardWidth: GAME_CONFIG.boardWidth,
    boardHeight: GAME_CONFIG.boardHeight
  });
}

// End the current round
function endRound() {
  gameState = "roundEnd";
  stateTimer = GAME_CONFIG.endRoundDelay;
  
  // Check for last man standing
  const alivePlayers = Object.values(players).filter(p => p.alive);
  
  // Update scores for surviving players
  if (alivePlayers.length === 1 && Object.keys(players).length > 1) {
    // Award last man standing bonus
    const lastPlayerId = alivePlayers[0].id;
    scores[lastPlayerId] = (scores[lastPlayerId] || 0) + GAME_CONFIG.lastManStandingBonus;
    
    // Update the persistent data
    const persistentId = players[lastPlayerId].persistentId;
    if (persistentId && playerData[persistentId]) {
      playerData[persistentId].score = scores[lastPlayerId];
    }
    
    // Inform clients about last man standing
    io.emit("lastManStanding", {
      playerId: lastPlayerId,
      bonus: GAME_CONFIG.lastManStandingBonus
    });
  } else {
    // Award normal points for surviving
    alivePlayers.forEach(player => {
      scores[player.id] = (scores[player.id] || 0) + 1;
      
      // Update the persistent data
      const persistentId = player.persistentId;
      if (persistentId && playerData[persistentId]) {
        playerData[persistentId].score = scores[player.id];
      }
    });
  }
  
  // Send updated scores to all clients
  io.emit("gameState", {
    gameState,
    players,
    scores,
    roundNumber,
    stateTimer,
    boardWidth: GAME_CONFIG.boardWidth,
    boardHeight: GAME_CONFIG.boardHeight
  });
}

// Game update function
function updateGame() {
  // Handle state transitions based on timers
  if (gameState === "preparing") {
    stateTimer -= GAME_CONFIG.updateInterval / 1000;
    
    // Update clients with countdown
    io.emit("gameState", {
      gameState,
      stateTimer: Math.max(0, stateTimer)
    });
    
    if (stateTimer <= 0) {
      startPlaying();
    }
    return;
  }
  else if (gameState === "roundEnd") {
    stateTimer -= GAME_CONFIG.updateInterval / 1000;
    
    // Update clients with countdown
    io.emit("gameState", {
      gameState,
      stateTimer: Math.max(0, stateTimer)
    });
    
    if (stateTimer <= 0) {
      roundNumber++;
      startNewRound();
    }
    return;
  }
  else if (gameState !== "playing") {
    return;
  }
  
  // Update timer
  roundTimer -= GAME_CONFIG.updateInterval / 1000;
  powerupTimer -= GAME_CONFIG.updateInterval / 1000;
  
  // Check if we should spawn new powerups
  if (powerupTimer <= 0 && powerups.length < GAME_CONFIG.powerupCount * 3) {
    // Reset powerup timer
    powerupTimer = GAME_CONFIG.powerupSpawnInterval;
    
    // Add a new powerup
    let newPowerup;
    let validPosition = false;
    
    // Try to find a valid position
    for (let attempts = 0; attempts < 10 && !validPosition; attempts++) {
      newPowerup = createPowerup();
      validPosition = true;
      
      // Check if this position overlaps with mines
      for (const mine of mines) {
        const dx = mine.x - newPowerup.x;
        const dy = mine.y - newPowerup.y;
        if (Math.sqrt(dx*dx + dy*dy) < 1) {
          validPosition = false;
          break;
        }
      }
      
      // Check if this position overlaps with other powerups
      if (validPosition) {
        for (const powerup of powerups) {
          const dx = powerup.x - newPowerup.x;
          const dy = powerup.y - newPowerup.y;
          if (Math.sqrt(dx*dx + dy*dy) < 1) {
            validPosition = false;
            break;
          }
        }
      }
    }
    
    // If we found a valid position, add the powerup
    if (validPosition) {
      powerups.push(newPowerup);
    }
  }
  
  if (roundTimer <= 0) {
    endRound();
    return;
  }
  
  // Track if any explosions happened this update
  let explosionHappened = false;
  
  // Update each player's position
  Object.keys(players).forEach(id => {
    const player = players[id];
    if (!player.alive || player.frozen) return;
    
    // Handle pausing behavior
    if (player.isPaused) {
      player.pauseTimer--;
      if (player.pauseTimer <= 0) {
        player.isPaused = false;
        // Get a new direction after pause
        const angle = Math.random() * 2 * Math.PI; // completely random new direction
        player.directionX = Math.cos(angle);
        player.directionY = Math.sin(angle);
        player.moveTimer = Math.floor(Math.random() * GAME_CONFIG.wanderMinMoveTime) + GAME_CONFIG.wanderMinMoveTime;
      }
      return; // Skip movement while paused
    }
    
    // Determine if player should pause
    if (Math.random() < GAME_CONFIG.wanderPauseChance) {
      player.isPaused = true;
      const minPause = GAME_CONFIG.wanderPauseDuration[0];
      const maxPause = GAME_CONFIG.wanderPauseDuration[1];
      player.pauseTimer = Math.floor(Math.random() * (maxPause - minPause + 1)) + minPause;
      return;
    }
    
    // Decrease move timer
    player.moveTimer--;
    
    // Check if we should change direction
    if (player.moveTimer <= 0 || Math.random() < GAME_CONFIG.wanderChangeDirChance) {
      // Get current angle
      const currentAngle = Math.atan2(player.directionY, player.directionX);
      
      // Get a random angle change within the max turn range
      const angleChange = (Math.random() * 2 - 1) * GAME_CONFIG.wanderMaxTurn;
      
      // Calculate new angle
      const newAngle = currentAngle + angleChange;
      
      // Update direction vector
      player.directionX = Math.cos(newAngle);
      player.directionY = Math.sin(newAngle);
      
      // Reset move timer
      player.moveTimer = Math.floor(Math.random() * GAME_CONFIG.wanderMinMoveTime) + GAME_CONFIG.wanderMinMoveTime;
    }
    
    // Update position based on direction
    player.x += player.directionX * GAME_CONFIG.playerSpeed;
    player.y += player.directionY * GAME_CONFIG.playerSpeed;
    
    // Bounce off walls
    if (player.x < 0) {
      player.x = 0;
      player.directionX *= -1;
    } else if (player.x > GAME_CONFIG.boardWidth) {
      player.x = GAME_CONFIG.boardWidth;
      player.directionX *= -1;
    }
    
    if (player.y < 0) {
      player.y = 0;
      player.directionY *= -1;
    } else if (player.y > GAME_CONFIG.boardHeight) {
      player.y = GAME_CONFIG.boardHeight;
      player.directionY *= -1;
    }
    
    // Check for powerup collection
    collectPowerup(player);
    
    // Check for mine collision
    if (hasMine(player.x, player.y)) {
      player.alive = false;
      explosionHappened = true;
      
      // Emit explosion event with player data
      io.emit("playerExploded", {
        playerId: player.id,
        x: player.x,
        y: player.y
      });
      
      // Check if this was the second-to-last player (making someone the last man standing)
      const alivePlayers = Object.values(players).filter(p => p.alive);
      if (alivePlayers.length === 1 && Object.keys(players).length > 1) {
        // Set a timeout to end the round after explosion animations can play out
        setTimeout(() => {
          endRound();
        }, 1500); // 1.5 seconds delay for explosion animation
        return;
      }
    }
  });
  
  // Check if round should end (all players hit mines)
  const allDead = Object.values(players).every(player => !player.alive);
  
  if (allDead && Object.keys(players).length > 0) {
    // If explosions happened in this update, delay the round end to let them play out
    if (explosionHappened) {
      setTimeout(() => {
        endRound();
      }, 1500); // 1.5 seconds delay for explosion animation
    } else {
      endRound();
    }
    return;
  }
  
  // Send updated game state to all clients
  io.emit("gameState", {
    gameState,
    players,
    powerups,
    roundTimer: Math.max(0, roundTimer),
    roundNumber,
    boardWidth: GAME_CONFIG.boardWidth,
    boardHeight: GAME_CONFIG.boardHeight
  });
}

// Socket.io connection
let onlineUsers = 0;

io.on("connection", (socket) => {
  console.log("A client connected");
  onlineUsers++;
  
  // Handle player registration/restoration
  socket.on("registerPlayer", (data) => {
    const persistentId = createOrRestorePlayer(socket.id, data.persistentId);
    
    // Send back the persistent ID to the client
    socket.emit("playerRegistered", {
      persistentId: persistentId,
      emoji: players[socket.id].emoji
    });
    
    // Broadcast the updated user count to all clients
    io.emit("userCount", onlineUsers);
    
    // Send game state to the player
    socket.emit("gameState", {
      gameState,
      players,
      mines: (gameState === "playing" || gameState === "preparing") ? mines : [],
      powerups: gameState === "playing" ? powerups : [],
      scores,
      roundNumber,
      roundTimer,
      stateTimer,
      boardWidth: GAME_CONFIG.boardWidth,
      boardHeight: GAME_CONFIG.boardHeight
    });
    
    // Start the game if it's the first player and game is not already running
    if (onlineUsers === 1 && !gameInterval) {
      gameState = "waiting";
      roundNumber = 1;
      startNewRound();
      gameInterval = setInterval(updateGame, GAME_CONFIG.updateInterval);
    }
  });

  // Handle reset game request - This is no longer needed but keep for backward compatibility
  socket.on("resetGame", () => {
    // Only allow resetting when round ends
    if (gameState === "roundEnd") {
      roundNumber = 1;
      Object.keys(scores).forEach(id => {
        scores[id] = 0;
      });
      startNewRound();
    }
  });
  
  socket.on("disconnect", () => {
    console.log("A client disconnected");
    onlineUsers--;
    
    // Store the player's data before removing them
    if (players[socket.id]) {
      const persistentId = players[socket.id].persistentId;
      if (persistentId && playerData[persistentId]) {
        // Update their score
        playerData[persistentId].score = scores[socket.id] || 0;
      }
      
      // Remove the player
      delete players[socket.id];
      delete scores[socket.id];
    }
    
    // Broadcast the updated user count to all clients
    io.emit("userCount", onlineUsers);
    
    // If no players left, clear the game interval
    if (onlineUsers === 0 && gameInterval) {
      clearInterval(gameInterval);
      gameInterval = null;
      gameState = "waiting";
    }
  });
});

// Route to serve QR code as SVG
app.get("/qrcode", (req, res) => {
  QRCode.toString(serverUrl, { type: "svg" }, function (err, qrSvg) {
    if (err) {
      res.status(500).send("Error generating QR code");
      return;
    }
    res.type("svg");
    res.send(qrSvg);
  });
});

// Start the server
server.listen(PORT, localIp, () => {
  console.log(`Server running at http://${localIp}:${PORT}/`);
  console.log(`You can also access it at http://localhost:${PORT}/`);

  // Create QR code for console
  QRCode.toString(
    serverUrl,
    {
      type: "terminal",
      small: true,
    },
    function (err, qrString) {
      if (err) throw err;
      console.log("\nScan this QR code to access the server:");
      console.log(qrString);
    }
  );
});

// When a player collects a powerup, update their persistent data
function collectPowerup(player) {
  const playerId = player.id;
  
  for (let i = powerups.length - 1; i >= 0; i--) {
    const powerup = powerups[i];
    const dx = powerup.x - player.x;
    const dy = powerup.y - player.y;
    const distance = Math.sqrt(dx*dx + dy*dy);
    
    if (distance < 0.6) { // Collision radius for powerup collection
      // Add points to player score
      scores[playerId] = (scores[playerId] || 0) + powerup.value;
      
      // Update persistent player data
      const persistentId = player.persistentId;
      if (persistentId && playerData[persistentId]) {
        playerData[persistentId].score = scores[playerId];
      }
      
      // Remove the collected powerup
      powerups.splice(i, 1);
      
      // Emit event for powerup collection
      io.emit("powerupCollected", {
        playerId,
        value: powerup.value,
        type: powerup.type
      });
      
      return true;
    }
  }
  
  return false;
}