import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  listInstances,
  createInstance,
  startInstance,
  stopInstance,
  deleteInstance,
} from "./docker.js";
import { getAdb } from "./adb.js";
import { ScrcpySession } from "./scrcpy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;

const app = express();
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
  const { name, androidVersion, port } = req.body || {};
  if (!name || !androidVersion || !port) {
    return res.status(400).json({ error: "name, androidVersion and port are required" });
  }
  res.json(await createInstance({ name, androidVersion, port }));
}));

app.post("/api/instances/:id/start", wrap(async (req, res) => {
  await startInstance(req.params.id);
  res.json({ ok: true });
}));

app.post("/api/instances/:id/stop", wrap(async (req, res) => {
  await stopInstance(req.params.id);
  res.json({ ok: true });
}));

app.delete("/api/instances/:id", wrap(async (req, res) => {
  await deleteInstance(req.params.id);
  res.json({ ok: true });
}));

const server = createServer(app);

// One active scrcpy session per adbPort, shared between stream and control sockets.
const sessions = new Map(); // adbPort -> { session, starting, refs }

async function acquireSession(adbPort) {
  let entry = sessions.get(adbPort);
  if (!entry) {
    const session = new ScrcpySession(null, adbPort);
    entry = { session, refs: 0, starting: null };
    sessions.set(adbPort, entry);
    entry.starting = (async () => {
      session.adb = await getAdb(adbPort);
      await session.start();
    })();
    entry.starting.catch(() => sessions.delete(adbPort));
  }
  await entry.starting;
  entry.refs++;
  return entry;
}

function releaseSession(adbPort, entry) {
  entry.refs--;
  if (entry.refs <= 0) {
    sessions.delete(adbPort);
    entry.session.close();
  }
}

const streamWss = new WebSocketServer({ noServer: true });
const controlWss = new WebSocketServer({ noServer: true });

streamWss.on("connection", async (ws, adbPort) => {
  let entry;
  try {
    entry = await acquireSession(adbPort);
  } catch (e) {
    ws.close(1011, `scrcpy start failed: ${e.message}`);
    return;
  }
  const { session } = entry;
  session.onPacket = (buf) => {
    if (ws.readyState === ws.OPEN) ws.send(buf);
  };
  session.onClose = () => ws.close(1000, "scrcpy exited");
  ws.on("close", () => {
    session.onPacket = undefined;
    session.onClose = undefined;
    releaseSession(adbPort, entry);
  });
});

controlWss.on("connection", async (ws, adbPort) => {
  let entry;
  try {
    entry = await acquireSession(adbPort);
  } catch (e) {
    ws.close(1011, `scrcpy start failed: ${e.message}`);
    return;
  }
  const { session } = entry;
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "touch") session.injectTouch(msg).catch(() => {});
    else if (msg.type === "key") session.injectKey(msg).catch(() => {});
    else if (msg.type === "text") session.injectText(String(msg.text)).catch(() => {});
  });
  ws.on("close", () => releaseSession(adbPort, entry));
});

server.on("upgrade", (req, socket, head) => {
  const m = req.url.match(/^\/ws\/(stream|control)\/(\d+)$/);
  if (!m) {
    socket.destroy();
    return;
  }
  const wss = m[1] === "stream" ? streamWss : controlWss;
  const adbPort = Number(m[2]);
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, adbPort));
});

server.listen(PORT, () => console.log(`SixDroid listening on :${PORT}`));
