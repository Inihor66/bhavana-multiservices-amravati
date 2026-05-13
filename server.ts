import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

// --- ESM/CJS Compatibility ---
const _filename = typeof import.meta !== 'undefined' && import.meta.url
  ? fileURLToPath(import.meta.url)
  : (typeof __filename !== 'undefined' ? __filename : '');

const _dirname = typeof import.meta !== 'undefined' && import.meta.url
  ? path.dirname(_filename)
  : (typeof __dirname !== 'undefined' ? __dirname : '');
// -----------------------------

const db = new Database("bhavana.db");

// Initialize Database
db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    phone TEXT,
    address TEXT,
    name TEXT,
    last_active DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id TEXT,
    sender TEXT,
    content TEXT,
    type TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    seen INTEGER DEFAULT 0,
    FOREIGN KEY(customer_id) REFERENCES customers(id)
  );
`);

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
    },
  });

  app.use(express.json({ limit: '50mb' }));

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", env: process.env.NODE_ENV });
  });

  // API Routes
  app.get("/api/admin/customers", (req, res) => {
    const customers = db.prepare("SELECT * FROM customers ORDER BY last_active DESC").all();
    res.json(customers);
  });

  app.get("/api/admin/messages/:customerId", (req, res) => {
    const messages = db.prepare("SELECT * FROM messages WHERE customer_id = ? ORDER BY timestamp ASC").all();
    res.json(messages);
  });

  app.post("/api/admin/reply", (req, res) => {
    const { customerId, content, type } = req.body;
    const stmt = db.prepare("INSERT INTO messages (customer_id, sender, content, type) VALUES (?, ?, ?, ?)");
    const info = stmt.run(customerId, 'admin', content, type || 'text');
    
    // Notify the specific customer
    io.to(customerId).emit("message", {
      id: info.lastInsertRowid,
      customer_id: customerId,
      sender: 'admin',
      content,
      type: type || 'text',
      timestamp: new Date().toISOString(),
      seen: 0
    });

    res.json({ success: true });
  });

  app.post("/api/customer/register", (req, res) => {
    const { id, phone, address, name } = req.body;
    const stmt = db.prepare("INSERT OR REPLACE INTO customers (id, phone, address, name, last_active) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)");
    stmt.run(id, phone, address, name);
    res.json({ success: true });
  });

  // Socket.io logic
  io.on("connection", (socket) => {
    console.log("A user connected:", socket.id);

    socket.on("join", (customerId) => {
      socket.join(customerId);
      console.log(`User ${customerId} joined their room`);
    });

    socket.on("sendMessage", (data) => {
      const { customerId, sender, content, type } = data;
      
      const stmt = db.prepare("INSERT INTO messages (customer_id, sender, content, type) VALUES (?, ?, ?, ?)");
      const info = stmt.run(customerId, sender, content, type || 'text');
      
      const message = {
        id: info.lastInsertRowid,
        customer_id: customerId,
        sender,
        content,
        type: type || 'text',
        timestamp: new Date().toISOString(),
        seen: 0
      };

      // Broadcast to admin room and customer room
      io.to(customerId).emit("message", message);
      io.emit("admin:new_message", message); // Simple broadcast to all admins for now
      
      // Update customer last active
      db.prepare("UPDATE customers SET last_active = CURRENT_TIMESTAMP WHERE id = ?").run(customerId);
    });

    socket.on("markSeen", (customerId) => {
      db.prepare("UPDATE messages SET seen = 1 WHERE customer_id = ? AND sender != 'admin'").run(customerId);
      io.emit("admin:seen_update", customerId);
    });

    socket.on("disconnect", () => {
      console.log("User disconnected");
    });
  });

  // Vite middleware for development
  const isProduction = process.env.NODE_ENV === "production";
  const isBundled = _filename.endsWith('.cjs');

  if (!isProduction && !isBundled) {
    console.log("Starting in DEVELOPMENT mode with Vite middleware");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    console.log("Starting in PRODUCTION mode");
    // When running node dist/server.cjs, _dirname is the dist folder
    // But wait, if server.ts is at root and bundled to dist/server.cjs,
    // _dirname becomes absolute path to dist/
    const staticPath = _dirname; 
    app.use(express.static(staticPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(staticPath, 'index.html'));
    });
  }

  const PORT = 3000;
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
