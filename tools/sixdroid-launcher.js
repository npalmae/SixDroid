import http from "node:http";
import { spawn } from "node:child_process";

const listenPort = 8090;
const deviceHost = process.env.SIXDROID_DEVICE_HOST || "10.176.160.187";

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const port = Number(url.searchParams.get("port"));
  const name = (url.searchParams.get("name") || `Android ${port}`).replace(/[^a-zA-Z0-9 _-]/g, "");

  if (url.pathname !== "/open" || !Number.isInteger(port) || port < 1024 || port > 65535) {
    res.writeHead(400).end("Invalid request");
    return;
  }

  const child = spawn("scrcpy", [
    "-s", `${deviceHost}:${port}`, "--no-audio", "--window-title", `SixDroid - ${name}`,
  ], { detached: true, stdio: "ignore" });
  child.unref();

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><title>SixDroid</title><p>Opening ${name} in scrcpy...</p><script>setTimeout(() => window.close(), 500)</script>`);
}).listen(listenPort, "127.0.0.1", () => {
  console.log(`SixDroid launcher listening on http://127.0.0.1:${listenPort}`);
});
