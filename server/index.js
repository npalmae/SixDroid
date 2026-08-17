import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import multer from "multer";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  listInstances,
  createInstance,
  startInstance,
  stopInstance,
  deleteInstance,
  createEmulatorInstance,
  remoteAction,
} from "./docker.js";
import { getAdb, runAdb } from "./adb.js";
import { ScrcpySession } from "./scrcpy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const execFileAsync = promisify(execFile);
const uploadDir = "/tmp/sixdroid-uploads";
await fs.mkdir(uploadDir, { recursive: true });
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 500 * 1024 * 1024, files: 1 },
});

const app = express();
app.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "web")));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  });

app.get("/api/instances", wrap(async (_req, res) => {
  res.json(await listInstances());
}));

app.post("/api/instances", wrap(async (req, res) => {
  const { name, androidVersion, port, type } = req.body || {};
  if (!name || !port) {
    return res.status(400).json({ error: "name and port are required" });
  }
  if (type === "emulator") {
    return res.json(await createEmulatorInstance({ name, port }));
  }
  if (!androidVersion) {
    return res.status(400).json({ error: "androidVersion is required" });
  }
  res.json(await createInstance({ name, androidVersion, port }));
}));

app.post("/api/instances/:id/start", wrap(async (req, res) => {
  if (req.params.id.startsWith("remote:")) {
    await remoteAction(req.params.id.slice(7), "start");
    return res.json({ ok: true });
  }
  await startInstance(req.params.id);
  res.json({ ok: true });
}));

app.post("/api/instances/:id/stop", wrap(async (req, res) => {
  if (req.params.id.startsWith("remote:")) {
    await remoteAction(req.params.id.slice(7), "stop");
    return res.json({ ok: true });
  }
  await stopInstance(req.params.id);
  res.json({ ok: true });
}));

app.delete("/api/instances/:id", wrap(async (req, res) => {
  if (req.params.id.startsWith("remote:")) {
    await remoteAction(req.params.id.slice(7), "delete");
    return res.json({ ok: true });
  }
  await deleteInstance(req.params.id);
  res.json({ ok: true });
}));

app.post("/api/files/distribute", upload.single("file"), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file is required" });

  let localPath = req.file.path;
  try {
    const ports = JSON.parse(req.body.ports || "[]").map(String);
    const action = req.body.action === "install" ? "install" : "copy";
    const safeName = path.basename(req.file.originalname).replace(/[^a-zA-Z0-9._ -]/g, "_");
    const instances = await listInstances();
    const allowed = new Map(
      instances.filter((i) => i.status === "running").map((i) => [i.host ? `${i.host}:${i.adbPort}` : String(i.adbPort), i])
    );
    const targets = [...new Set(ports.map(String))].filter((p) => allowed.has(p));
    if (!targets.length) return res.status(400).json({ error: "select at least one running Android" });
    if (action === "install" && !safeName.toLowerCase().endsWith(".apk")) {
      return res.status(400).json({ error: "only APK files can be installed" });
    }
    if (action === "install") {
      localPath = `${req.file.path}.apk`;
      await fs.rename(req.file.path, localPath);
    }

    const results = await Promise.all(targets.map(async (key) => {
      const inst = allowed.get(key);
      try {
        const args = action === "install"
          ? ["install", "-r", localPath]
          : ["push", localPath, `/sdcard/Download/${safeName}`];
        const { stdout, stderr } = await runAdb(inst.adbPort, args, { timeout: 10 * 60 * 1000 }, inst.host);
        return { port: inst.adbPort, name: inst.name, ok: true, message: (stdout || stderr).trim() };
      } catch (error) {
        return { port: inst.adbPort, name: inst.name, ok: false, message: error.stderr?.trim() || error.message };
      }
    }));
    res.json({ action, filename: safeName, results });
  } finally {
    await fs.unlink(localPath).catch(() => {});
    if (localPath !== req.file.path) await fs.unlink(req.file.path).catch(() => {});
  }
}));

app.post("/api/automation/:port", wrap(async (req, res) => {
  const port = Number(req.params.port);
  const host = req.query.host;
  const instances = await listInstances();
  const instance = instances.find((item) =>
    item.adbPort === port && item.status === "running" &&
    (host ? item.host === host : !item.host)
  );
  if (!instance) return res.status(404).json({ error: "running Android not found" });

  const action = req.body?.action;
  if (!["inspect", "setText", "click", "tap", "swipe", "press"].includes(action)) {
    return res.status(400).json({ error: "unsupported automation action" });
  }
  const selector = req.body?.selector || {};
  if (["setText", "click"].includes(action) && ![selector.resourceId, selector.text, selector.description].some(Boolean)) {
    return res.status(400).json({ error: "selector is required" });
  }

  await runAdb(port, ["get-state"], { timeout: 30000 }, instance.host);
  const payload = JSON.stringify({
    serial: `${instance.host || process.env.DEVICE_HOST || "10.141.10.152"}:${port}`,
    action,
    selector,
    value: String(req.body?.value ?? "").slice(0, 4096),
    x: Number(req.body?.x),
    y: Number(req.body?.y),
    x1: Number(req.body?.x1),
    y1: Number(req.body?.y1),
    x2: Number(req.body?.x2),
    y2: Number(req.body?.y2),
    duration: Number(req.body?.duration) || 0.3,
    key: req.body?.key,
  });
  try {
    const { stdout } = await execFileAsync("/opt/uia2/bin/python", ["/app/ui_automation.py", payload], {
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
    });
    res.json(JSON.parse(stdout));
  } catch (error) {
    const output = error.stdout?.trim();
    if (output) {
      const result = JSON.parse(output);
      return res.status(400).json(result);
    }
    throw error;
  }
}));

const server = createServer(app);

// One active scrcpy session per device key ("host:port" or bare port).
const sessions = new Map(); // key -> { session, starting, refs }

async function acquireSession(adbPort, host) {
  const key = host ? `${host}:${adbPort}` : String(adbPort);
  let entry = sessions.get(key);
  if (!entry) {
    const session = new ScrcpySession(null, adbPort);
    session.host = host;
    entry = { session, refs: 0, starting: null };
    sessions.set(key, entry);
    entry.starting = (async () => {
      console.log(`[scrcpy:${key}] connecting adb`);
      session.adb = await getAdb(adbPort, host);
      console.log(`[scrcpy:${key}] starting server`);
      await session.start();
      console.log(`[scrcpy:${key}] ready ${session.width}x${session.height}`);
    })();
    entry.starting.catch((error) => {
      console.error(`[scrcpy:${key}] start failed`, error);
      sessions.delete(key);
    });
  }
  await entry.starting;
  entry.refs++;
  return entry;
}

function releaseSession(key, entry) {
  entry.refs--;
  if (entry.refs <= 0) {
    sessions.delete(key);
    entry.session.close();
  }
}

const streamWss = new WebSocketServer({ noServer: true });
const controlWss = new WebSocketServer({ noServer: true });

streamWss.on("connection", async (ws, adbPort, host) => {
  const key = host ? `${host}:${adbPort}` : String(adbPort);
  console.log(`[ws:${key}] stream connected`);
  let entry;
  try {
    entry = await acquireSession(adbPort, host);
  } catch (e) {
    console.error(`[ws:${key}] stream failed`, e);
    ws.close(1011, `scrcpy start failed: ${e.message}`);
    return;
  }
  const { session } = entry;
  session.onPacket = (buf) => {
    if (ws.readyState === ws.OPEN) ws.send(buf);
  };
  session.flushPackets();
  session.onClose = () => ws.close(1000, "scrcpy exited");
  ws.on("close", () => {
    console.log(`[ws:${key}] stream closed`);
    session.onPacket = undefined;
    session.onClose = undefined;
    releaseSession(key, entry);
  });
});

controlWss.on("connection", async (ws, adbPort, host) => {
  const key = host ? `${host}:${adbPort}` : String(adbPort);
  console.log(`[ws:${key}] control connected`);
  let entry;
  try {
    entry = await acquireSession(adbPort, host);
  } catch (e) {
    console.error(`[ws:${key}] control failed`, e);
    ws.close(1011, `scrcpy start failed: ${e.message}`);
    return;
  }
  const { session } = entry;
  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    try {
      if (msg.type === "touch") await session.injectTouch(msg);
      else if (msg.type === "key") await session.injectKey(msg);
      else if (msg.type === "text") await session.injectText(String(msg.text));
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ ok: true, type: msg.type, action: msg.action }));
    } catch (error) {
      console.error(`[ws:${key}] control ${msg.type} failed`, error);
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ ok: false, error: error.message }));
    }
  });
  ws.on("close", () => releaseSession(key, entry));
});

server.on("upgrade", (req, socket, head) => {
  const m = req.url.match(/^\/ws\/(stream|control)\/(\d+)(\?.*)?$/);
  if (!m) {
    socket.destroy();
    return;
  }
  const wss = m[1] === "stream" ? streamWss : controlWss;
  const adbPort = Number(m[2]);
  const host = new URL(req.url, "http://x").searchParams.get("host") || undefined;
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, adbPort, host));
});

server.listen(PORT, () => console.log(`SixDroid listening on :${PORT}`));
