// Instance list management + view switching. The video player is imported
// lazily so unsupported WebCodecs cannot prevent the instance list loading.

const tbody = document.querySelector("#instances-table tbody");
const createForm = document.getElementById("create-form");
const portInput = document.getElementById("f-port");
const instancesView = document.getElementById("instances-view");
const screenView = document.getElementById("screen-view");
const screenTitle = document.getElementById("screen-title");
const screenStatus = document.getElementById("screen-status");
const canvas = document.getElementById("screen-canvas");
const screenLog = document.getElementById("screen-log");
const shareForm = document.getElementById("share-form");
const shareTargets = document.getElementById("share-targets");
const shareResult = document.getElementById("share-result");

let player = null;

async function api(path, options) {
  const res = await fetch(path, options && {
    method: options.method || "POST",
    headers: { "content-type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

function suggestPort(instances) {
  const used = new Set(instances.map((i) => i.adbPort).filter(Boolean));
  let p = 5555;
  while (used.has(p)) p++;
  return p;
}

async function refresh() {
  let instances;
  try {
    instances = await api("/api/instances");
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5">Error: ${e.message}</td></tr>`;
    return;
  }
  if (!portInput.value) portInput.value = suggestPort(instances);
  const selectedPorts = new Set([...shareTargets.querySelectorAll("input:checked")].map((input) => Number(input.value)));
  shareTargets.innerHTML = "";
  for (const inst of instances.filter((item) => item.status === "running" && item.adbPort)) {
    const label = document.createElement("label");
    const checked = selectedPorts.size ? selectedPorts.has(inst.adbPort) : true;
    label.innerHTML = `<input type="checkbox" value="${inst.adbPort}" ${checked ? "checked" : ""}> ${inst.name} (:${inst.adbPort})`;
    shareTargets.appendChild(label);
  }
  tbody.innerHTML = "";
  for (const inst of instances) {
    const tr = document.createElement("tr");
    const statusCls = inst.status === "running" ? "status-running" : "status-stopped";
    const booted = inst.status === "running" ? (inst.booted ? " · booted" : " · booting…") : "";
    tr.innerHTML = `
      <td>${inst.name}</td>
      <td>${inst.androidVersion}${inst.gapps ? " · GApps" : ""}</td>
      <td class="${statusCls}">${inst.status}${booted}</td>
      <td>${inst.adbPort ?? "-"}</td>
      <td class="actions"></td>`;
    const actions = tr.querySelector(".actions");
    const btn = (label, cls, fn, disabled) => {
      const b = document.createElement("button");
      b.textContent = label;
      if (cls) b.className = cls;
      b.disabled = !!disabled;
      b.onclick = async () => { b.disabled = true; try { await fn(); } catch (e) { alert(e.message); } refresh(); };
      actions.appendChild(b);
      return b;
    };
    if (inst.status === "running") {
      btn("Ver pantalla", "", () => openScreen(inst), !inst.adbPort);
      btn("Abrir scrcpy", "secondary", () => {
        const query = new URLSearchParams({ port: inst.adbPort, name: inst.name });
        window.open(`http://127.0.0.1:8090/open?${query}`, "_blank");
      }, !inst.adbPort);
      btn("Stop", "secondary", () => api(`/api/instances/${inst.id}/stop`));
    } else {
      btn("Start", "secondary", () => api(`/api/instances/${inst.id}/start`));
    }
    btn("Delete", "danger", () => {
      if (confirm(`Delete ${inst.name}?`)) return api(`/api/instances/${inst.id}`, { method: "DELETE" });
    });
    tbody.appendChild(tr);
  }
  if (!instances.length) {
    tbody.innerHTML = `<tr><td colspan="5">No redroid containers found.</td></tr>`;
  }
}

async function openScreen(inst) {
  instancesView.classList.add("hidden");
  screenView.classList.remove("hidden");
  screenTitle.textContent = `${inst.name} (Android ${inst.androidVersion}, :${inst.adbPort})`;
  screenLog.textContent = "";
  let ScreenPlayer;
  try {
    ({ ScreenPlayer } = await import("./player.js"));
  } catch (error) {
    screenStatus.textContent = "player unavailable";
    screenLog.textContent = `Could not load player: ${error.message || error}`;
    return;
  }
  player = new ScreenPlayer({
    canvas,
    adbPort: inst.adbPort,
    onStatus: (s) => (screenStatus.textContent = s),
    onLog: (message) => {
      const time = new Date().toLocaleTimeString();
      screenLog.textContent += `[${time}] ${message}\n`;
      screenLog.scrollTop = screenLog.scrollHeight;
    },
  });
  player.start();
}

function closeScreen() {
  player?.stop();
  player = null;
  screenView.classList.add("hidden");
  instancesView.classList.remove("hidden");
  refresh();
}

document.getElementById("btn-back-list").onclick = closeScreen;
document.getElementById("btn-clear-log").onclick = () => (screenLog.textContent = "");

shareForm.onsubmit = async (event) => {
  event.preventDefault();
  const file = document.getElementById("share-file").files[0];
  const ports = [...shareTargets.querySelectorAll("input:checked")].map((input) => Number(input.value));
  if (!file || !ports.length) {
    shareResult.textContent = "Select a file and at least one Android.";
    return;
  }

  const button = shareForm.querySelector("button");
  const data = new FormData();
  data.append("file", file);
  data.append("ports", JSON.stringify(ports));
  data.append("action", document.getElementById("share-action").value);
  button.disabled = true;
  shareResult.textContent = `Uploading ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)…`;
  try {
    const response = await fetch("/api/files/distribute", { method: "POST", body: data });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || response.statusText);
    shareResult.textContent = result.results.map((item) =>
      `${item.ok ? "OK" : "ERROR"} ${item.name}: ${item.message}`
    ).join("\n");
  } catch (error) {
    shareResult.textContent = `ERROR: ${error.message}`;
  } finally {
    button.disabled = false;
  }
};

createForm.onsubmit = async (e) => {
  e.preventDefault();
  const body = {
    name: document.getElementById("f-name").value.trim(),
    androidVersion: document.getElementById("f-version").value,
    port: Number(portInput.value),
  };
  try {
    await api("/api/instances", { body });
    createForm.reset();
    portInput.value = "";
  } catch (err) {
    alert(err.message);
  }
  refresh();
};

window.addEventListener("error", (event) => {
  if (tbody.children.length === 0 || tbody.textContent.includes("Loading instances")) {
    tbody.innerHTML = `<tr><td colspan="5">JavaScript error: ${event.message}</td></tr>`;
  }
});

refresh();
setInterval(() => { if (!screenView.classList.contains("hidden")) return; refresh(); }, 5000);
