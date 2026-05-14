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

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION at:', promise, 'reason:', reason);
});

async function startServer() {
  console.log('Starting server...');
  console.log('CWD:', process.cwd());
  console.log('Filename:', _filename);
  console.log('Dirname:', _dirname);
  const db = new Database("bhavana.db");
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

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

  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 1e8,
    pingTimeout: 120000,
    pingInterval: 25000,
  });

  // Socket monitoring
  io.engine.on("connection_error", (err) => {
    console.error("Socket.io Engine Connection Error:", err.req ? `${err.req.method} ${err.req.url}` : 'No request', "Message:", err.message);
  });

  app.use(express.json({ limit: '50mb' }));

  // Logging middleware
  app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    next();
  });

  // Health check
  app.get("/api/health", (req, res) => {
    console.log("Health check hit");
    res.json({ 
      status: "ok", 
      socket_clients: io.engine.clientsCount,
      env: process.env.NODE_ENV,
    });
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
    const { customerId, content, type, tempId } = req.body;
    console.log(`Admin replying to ${customerId}:`, content);
    const stmt = db.prepare("INSERT INTO messages (customer_id, sender, content, type) VALUES (?, ?, ?, ?)");
    const info = stmt.run(customerId, 'admin', content, type || 'text');
    
    const message = {
      id: info.lastInsertRowid,
      customer_id: customerId,
      sender: 'admin',
      content,
      type: type || 'text',
      timestamp: new Date().toISOString(),
      seen: 0,
      tempId
    };

    // Notify the specific customer
    io.to(customerId).emit("message", message);
    
    // notify other admins
    io.to("admins").emit("admin:new_message", message);

    res.json({ success: true });
  });

  app.post("/api/customer/register", (req, res) => {
    const { id, phone, address, name } = req.body;
    console.log(`Registering customer ${id}:`, { phone, name });
    const stmt = db.prepare("INSERT OR REPLACE INTO customers (id, phone, address, name, last_active) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)");
    stmt.run(id, phone, address, name);
    res.json({ success: true });
  });

  // Socket.io logic
  io.on("connection", (socket) => {
    console.log("A user connected:", socket.id);

    socket.on("join", (customerId) => {
      socket.join(customerId);
      console.log(`User ${customerId} joined their room (Socket ID: ${socket.id})`);
    });

    socket.on("joinAdmin", () => {
      socket.join("admins");
      console.log(`Admin joined room (Socket ID: ${socket.id})`);
    });

    socket.on("sendMessage", (data) => {
      const { customerId, sender, content, type, tempId } = data;
      console.log(`Socket [${socket.id}] received message from ${sender} for ${customerId} (Type: ${type}, ContentLen: ${content?.length}, TempId: ${tempId})`);
      
      try {
        if (!customerId) {
          console.warn("sendMessage: Missing customerId");
          return;
        }

        // Ensure customer exists (upsert)
        const checkCustomer = db.prepare("SELECT id FROM customers WHERE id = ?").get(customerId);
        if (!checkCustomer) {
          console.log(`Customer ${customerId} not found, creating placeholder.`);
          db.prepare("INSERT INTO customers (id, last_active) VALUES (?, CURRENT_TIMESTAMP)").run(customerId);
        }

        const stmt = db.prepare("INSERT INTO messages (customer_id, sender, content, type) VALUES (?, ?, ?, ?)");
        const info = stmt.run(customerId, sender, content, type || 'text');
        
        const message = {
          id: info.lastInsertRowid,
          customer_id: customerId,
          sender,
          content,
          type: type || 'text',
          timestamp: new Date().toISOString(),
          seen: 0,
          tempId // Echo back the tempId
        };

        console.log(`Saved message ID ${message.id}. Emitting to room ${customerId} and admins.`);

        // Broadcast to customer room
        io.to(customerId).emit("message", message);
        
        // Also emit directly to the sender as a safety measure
        socket.emit("message", message);
        
        // Broadcast to all admins
        io.to("admins").emit("admin:new_message", message); 
        
        // Update customer last active
        db.prepare("UPDATE customers SET last_active = CURRENT_TIMESTAMP WHERE id = ?").run(customerId);
      } catch (err) {
        console.error("Error saving/emitting message:", err);
      }
    });

    socket.on("markSeen", (customerId) => {
      db.prepare("UPDATE messages SET seen = 1 WHERE customer_id = ? AND sender != 'admin'").run(customerId);
      io.emit("admin:seen_update", customerId);
    });

    socket.on("disconnect", () => {
      console.log("User disconnected");
    });
  });

  // ... (API and Socket.io routes above)

  // Frontend serving logic (must be last)
  const isBundled = _filename.endsWith('.cjs');
  const isProduction = process.env.NODE_ENV === "production" || isBundled;

  if (!isProduction) {
    console.log("Starting in DEVELOPMENT mode with Vite middleware");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);

    // SPA fallback for dev mode
    app.get('*', async (req, res, next) => {
      const url = req.originalUrl;
      if (url.startsWith('/api') || url.startsWith('/socket.io')) return next();
      try {
        const fs = await import('fs');
        const templatePath = path.resolve(_dirname, 'index.html');
        let template = fs.readFileSync(templatePath, 'utf-8');
        template = await vite.transformIndexHtml(url, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
      } catch (e) {
        vite.ssrFixStacktrace(e as Error);
        next(e);
      }
    });
  } else {
    console.log("Starting in PRODUCTION mode");
    // If bundled, _dirname is dist/. If not bundled (e.g. running from root in prod), it's root.
    const distPath = isBundled ? _dirname : path.join(_dirname, 'dist');
    const indexPath = path.join(distPath, 'index.html');
    
    console.log("Static files from:", distPath);
    console.log("Fallback index.html:", indexPath);

    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(indexPath);
    });
  }

  const PORT = 3000;
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
