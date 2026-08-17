import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AdbServerClient } from "@yume-chan/adb";
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp";

const execFileAsync = promisify(execFile);

export const DEVICE_HOST = process.env.DEVICE_HOST || "10.141.10.152";

// The adb server runs inside this container (started in the Dockerfile CMD).
const connector = new AdbServerNodeTcpConnector({ host: "127.0.0.1", port: 5037 });
export const adbServer = new AdbServerClient(connector);

export async function runAdb(adbPort, args, options = {}, host) {
  const serial = `${host || DEVICE_HOST}:${adbPort}`;
  await execFileAsync("adb", ["connect", serial]);
  return execFileAsync("adb", ["-s", serial, ...args], {
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
}

/**
 * Lazily `adb connect DEVICE_HOST:adbPort` and return a Tango `Adb` instance
 * for that device. Retries a couple of times because redroid takes a while
 * to bring adbd up after container start.
 */
export async function getAdb(adbPort, host) {
  const serial = `${host || DEVICE_HOST}:${adbPort}`;

  let lastError;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const { stdout } = await execFileAsync("adb", ["connect", serial]);
      if (/connected|already connected/.test(stdout)) {
        // verify it shows up as a device (not offline/authorizing)
        const devices = await adbServer.getDevices();
        const dev = devices.find((d) => d.serial === serial);
        if (dev && dev.state === "device") {
          return adbServer.createAdb({ serial });
        }
      }
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw lastError || new Error(`Unable to adb connect ${serial}`);
}
