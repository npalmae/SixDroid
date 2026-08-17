import http from "node:http";
import { spawn, execFileSync } from "node:child_process";

const listenPort = 8090;
const deviceHost = process.env.SIXDROID_DEVICE_HOST || "10.176.160.187";

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const port = Number(url.searchParams.get("port"));
  const host = url.searchParams.get("host") || deviceHost;
  const name = (url.searchParams.get("name") || `Android ${port}`).replace(/[^a-zA-Z0-9 _-]/g, "");

  if (url.pathname !== "/open" || !Number.isInteger(port) || port < 1024 || port > 65535 || !/^[0-9.]+$/.test(host)) {
    res.writeHead(400).end("Invalid request");
    return;
  }

  const serial = `${host}:${port}`;
  try { execFileSync("adb", ["connect", serial], { timeout: 10000 }); } catch {}
  const args = ["-s", serial, "--no-audio", "--window-title", `SixDroid - ${name}`];
  if (url.searchParams.get("host")) args.push("--mouse=uhid", "--keyboard=uhid", "--max-fps=30");
  const child = spawn("scrcpy", args, { detached: true, stdio: "ignore" });
  child.unref();

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><title>SixDroid</title><p>Opening ${name} in scrcpy...</p><script>setTimeout(() => window.close(), 500)</script>`);
}).listen(listenPort, "127.0.0.1", () => {
  console.log(`SixDroid launcher listening on http://127.0.0.1:${listenPort}`);
});
