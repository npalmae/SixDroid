import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";

const run = promisify(execFile);
const HOME = process.env.HOME;
const ANDROID_HOME = `${HOME}/android-sdk`;
const ENV = {
  ...process.env,
  ANDROID_HOME,
  ANDROID_SDK_ROOT: ANDROID_HOME,
  PATH: `${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/emulator:${process.env.PATH}`,
};
const BIND = "10.176.160.231";
const REGISTRY = `${HOME}/avd-registry.json`;

async function loadRegistry() {
  try { return JSON.parse(await fs.readFile(REGISTRY, "utf8")); } catch { return {}; }
}
async function saveRegistry(reg) {
  await fs.writeFile(REGISTRY, JSON.stringify(reg, null, 2));
}

async function avdState(name, port) {
  try {
    const { stdout } = await run("adb", ["-s", `emulator-${port}`, "shell", "getprop", "sys.boot_completed"], { env: ENV, timeout: 5000 });
    return { status: "running", booted: stdout.trim() === "1" };
  } catch {
    return { status: "stopped", booted: false };
  }
}

async function list() {
  const reg = await loadRegistry();
  return Promise.all(Object.entries(reg).map(async ([name, { port }]) => ({
    name,
    image: "google-play-avd",
    androidVersion: "15",
    gapps: true,
    adbPort: port + 1, // host ZeroTier port (socat proxy)
    kind: "emulator",
    managed: true,
    ...(await avdState(name, port)),
  })));
}

async function create(name, port) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("invalid name");
  port = Number(port);
  if (!(port % 2 === 0 && port >= 5554 && port <= 5684)) throw new Error("port must be even 5554-5684");
  const reg = await loadRegistry();
  if (reg[name]) throw new Error("name exists");
  if (Object.values(reg).some((r) => r.port === port)) throw new Error("port in use");

  await run("bash", ["-c", `echo no | avdmanager create avd --force --name "${name}" --package "system-images;android-35;google_apis_playstore;x86_64" --device "pixel_6"`], { env: ENV, timeout: 60000 });
  reg[name] = { port };
  await saveRegistry(reg);
  await start(name);

  // adb proxy on ZeroTier (console port = port, adb port = port + 1)
  await run("bash", ["-c", `nohup socat TCP-LISTEN:${port + 1},bind=${BIND},reuseaddr,fork TCP:127.0.0.1:${port + 1} > "$HOME/adb-proxy-${name}.log" 2>&1 &`], { timeout: 5000 });
  return { name, port };
}

async function start(name) {
  const reg = await loadRegistry();
  const entry = reg[name];
  if (!entry) throw new Error("unknown AVD");
  const state = await avdState(name, entry.port);
  if (state.status === "running") return;
  await run("bash", ["-c",
    `nohup emulator -avd "${name}" -port ${entry.port} -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -camera-back emulated -camera-front emulated -memory 8192 -cores 8 -no-snapshot-save -skip-adb-auth > "$HOME/emulator-${name}.log" 2>&1 &`
  ], { env: ENV, timeout: 5000 });
}

async function stop(name) {
  const reg = await loadRegistry();
  const entry = reg[name];
  if (!entry) throw new Error("unknown AVD");
  await run("adb", ["-s", `emulator-${entry.port}`, "emu", "kill"], { env: ENV, timeout: 10000 }).catch(() => {});
}

async function remove(name) {
  await stop(name).catch(() => {});
  await run("avdmanager", ["delete", "avd", "--name", name], { env: ENV, timeout: 30000 });
  const reg = await loadRegistry();
  const port = reg[name]?.port;
  delete reg[name];
  await saveRegistry(reg);
  if (port) await run("bash", ["-c", `pkill -f "TCP-LISTEN:${port + 1}" || true`], { timeout: 5000 }).catch(() => {});
}

async function authorize(name) {
  const reg = await loadRegistry();
  const entry = reg[name];
  if (!entry) throw new Error("unknown AVD");
  const serial = `emulator-${entry.port}`;
  const tapNode = async (dump, resourceId) => {
    const m = dump.match(new RegExp(`resource-id="android:id/${resourceId}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`))
      || dump.match(new RegExp(`bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"[^>]*resource-id="android:id/${resourceId}"`));
    if (!m) return false;
    const x = Math.round((Number(m[1]) + Number(m[3])) / 2);
    const y = Math.round((Number(m[2]) + Number(m[4])) / 2);
    await run("adb", ["-s", serial, "shell", "input", "tap", String(x), String(y)], { env: ENV, timeout: 10000 });
    return true;
  };
  // Wait for the "Allow USB debugging?" dialog and accept it ("Always allow").
  for (let i = 0; i < 30; i++) {
    const { stdout } = await run("adb", ["-s", serial, "exec-out", "uiautomator", "dump", "/dev/tty"], { env: ENV, timeout: 15000 }).catch(() => ({ stdout: "" }));
    if (stdout.includes("Allow USB debugging")) {
      await tapNode(stdout, "alwaysUse");
      if (await tapNode(stdout, "button1")) return { ok: true };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { ok: false, error: "dialog not found" };
}

const routes = {
  "GET /instances": () => list(),
  "POST /instances": (b) => create(b.name, b.port),
  "POST /start": (b) => start(b.name),
  "POST /stop": (b) => stop(b.name),
  "POST /delete": (b) => remove(b.name),
  "POST /authorize": (b) => authorize(b.name),
};

http.createServer(async (req, res) => {
  const route = routes[`${req.method} ${req.url.split("?")[0]}`];
  res.setHeader("content-type", "application/json");
  if (!route) { res.writeHead(404).end('{"error":"not found"}'); return; }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    try {
      const result = await route(body ? JSON.parse(body) : {});
      res.writeHead(200).end(JSON.stringify(result ?? { ok: true }));
    } catch (e) {
      res.writeHead(500).end(JSON.stringify({ error: e.message }));
    }
  });
}).listen(4780, BIND, () => console.log(`sixdroid-emulator-agent on ${BIND}:4780`));
