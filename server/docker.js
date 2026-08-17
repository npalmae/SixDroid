import Docker from "dockerode";

export const docker = new Docker({ socketPath: "/var/run/docker.sock" });

const IMAGE_PREFIX = "redroid/redroid";

function parseAndroidVersion(image) {
  // image: "redroid/redroid:15.0.0-latest" -> "15"
  const tag = image.split(":")[1] || "";
  const m = tag.match(/^(\d+)\./);
  return m ? m[1] : tag;
}

function parseAdbPort(container) {
  // find host port mapped to container 5555/tcp
  for (const p of container.Ports || []) {
    if (p.PrivatePort === 5555 && p.PublicPort) return p.PublicPort;
  }
  return null;
}

async function isBooted(containerId, status) {
  if (status !== "running") return false;
  try {
    const exec = await docker.getContainer(containerId).exec({
      Cmd: ["sh", "-c", "getprop sys.boot_completed"],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true });
    const chunks = [];
    await new Promise((resolve, reject) => {
      stream.on("data", (c) => chunks.push(c));
      stream.on("end", resolve);
      stream.on("error", reject);
      setTimeout(resolve, 3000);
    });
    return Buffer.concat(chunks).toString("utf8").includes("1");
  } catch {
    return false;
  }
}

async function toInstance(c) {
  const name = (c.Names?.[0] || "").replace(/^\//, "");
  const status = c.State === "running" ? "running" : "stopped";
  return {
    id: c.Id,
    name,
    image: c.Image,
    status,
    androidVersion: c.Labels?.["sixdroid.version"] || parseAndroidVersion(c.Image),
    gapps: c.Labels?.["sixdroid.gapps"] === "true",
    adbPort: parseAdbPort(c),
    booted: await isBooted(c.Id, status),
  };
}

export async function listInstances() {
  const containers = await docker.listContainers({ all: true });
  const redroids = containers.filter((c) =>
    c.Image.startsWith(IMAGE_PREFIX) || c.Labels?.["sixdroid.android"] === "true"
  );
  const local = await Promise.all(redroids.map(toInstance));
  let remote = [];
  try {
    remote = JSON.parse(process.env.REMOTE_ANDROIDS || "[]").map((item) => ({
      id: `remote:${item.name}`,
      name: item.name,
      image: item.image || "remote-android",
      status: "running",
      androidVersion: String(item.androidVersion || ""),
      gapps: Boolean(item.gapps),
      adbPort: Number(item.adbPort),
      booted: true,
      managed: false,
      kind: "emulator",
    }));
  } catch (error) {
    console.error("Invalid REMOTE_ANDROIDS", error);
  }
  return [...remote, ...local.map((item) => ({ ...item, managed: true, kind: "container" }))];
}

export async function createInstance({ name, androidVersion, port }) {
  const image = `${IMAGE_PREFIX}:${androidVersion}.0.0-latest`;

  // pull image if not present locally
  const images = await docker.listImages();
  const found = images.some((img) => (img.RepoTags || []).includes(image));
  if (!found) {
    const stream = await docker.pull(image);
    await new Promise((resolve, reject) => {
      docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
    });
  }

  const container = await docker.createContainer({
    Image: image,
    name: `sixdroid-${name}`,
    Privileged: true,
    HostConfig: {
      Privileged: true,
      PortBindings: { "5555/tcp": [{ HostPort: String(port) }] },
    },
    ExposedPorts: { "5555/tcp": {} },
  });
  await container.start();
  const info = await container.inspect();
  return {
    id: info.Id,
    name: info.Name.replace(/^\//, ""),
    image,
    status: "running",
    androidVersion,
    adbPort: Number(port),
    booted: false,
  };
}

export async function startInstance(id) {
  await docker.getContainer(id).start();
}

export async function stopInstance(id) {
  await docker.getContainer(id).stop({ t: 5 });
}

export async function deleteInstance(id) {
  const c = docker.getContainer(id);
  try {
    await c.stop({ t: 3 });
  } catch {
    /* already stopped */
  }
  await c.remove({ force: true });
}
