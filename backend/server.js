import express from "express";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import priceRouter from "./routes/price.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "10kb" }));

// --- CORS middleware ---
const allowedOriginsEnv = process.env.ALLOWED_ORIGINS || "";
const allowedOrigins = allowedOriginsEnv.split(",").map(s => s.trim()).filter(Boolean);

function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  if (allowedOrigins.length === 0) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  } else if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
}

app.use(corsMiddleware);

// Serve frontend files directly from frontend folder (no directory listing)
const frontendPath = path.join(__dirname, "..", "frontend");
app.use(express.static(frontendPath, { index: "index.html", dotfiles: "deny" }));

// API routes
app.use("/api", priceRouter);

// SPA fallback: serve index.html for any unmatched route (except /api/*)
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(frontendPath, "index.html"));
});

// Error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  const status = err?.status || 500;
  const msg = process.env.NODE_ENV === "production" ? "Internal Server Error" : err?.message || "Internal Server Error";
  res.status(status).json({ error: msg });
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Frontend: http://127.0.0.1:${PORT}`);
});
