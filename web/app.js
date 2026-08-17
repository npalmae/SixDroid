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
const automationDevice = document.getElementById("automation-device");
const automationSelector = document.getElementById("automation-selector");
const automationValue = document.getElementById("automation-value");
const automationResult = document.getElementById("automation-result");
const automationTbody = document.querySelector("#automation-table tbody");

let player = null;
let currentInstances = [];

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

function usedPorts(instances) {
  const used = new Set();
  for (const i of instances) {
    if (!i.adbPort) continue;
    used.add(i.adbPort);
    if (i.kind === "emulator") used.add(i.adbPort - 1); // console port
  }
  return used;
}

function suggestPort(instances) {
  const used = usedPorts(instances);
  let p = 5555;
  while (used.has(p)) p++;
  return p;
}

function suggestEmulatorPort(instances) {
  const used = usedPorts(instances);
  let p = 5554;
  while (used.has(p) || used.has(p + 1)) p += 2;
  return p;
}

async function refresh() {
  let instances;
  try {
    instances = await api("/api/instances");
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6">Error: ${e.message}</td></tr>`;
    return;
  }
  if (!portInput.value) portInput.value = suggestPort(instances);
  currentInstances = instances;
  const selectedPorts = new Set([...shareTargets.querySelectorAll("input:checked")].map((input) => input.value));
  const selectedAutomationPort = automationDevice.value;
  shareTargets.innerHTML = "";
  for (const inst of instances.filter((item) => item.status === "running" && item.adbPort)) {
    const label = document.createElement("label");
    const key = inst.host ? `${inst.host}:${inst.adbPort}` : String(inst.adbPort);
    const checked = selectedPorts.size ? selectedPorts.has(key) : true;
    label.innerHTML = `<input type="checkbox" value="${key}" ${checked ? "checked" : ""}> ${inst.name} (:${inst.adbPort})`;
    shareTargets.appendChild(label);
  }
  automationDevice.innerHTML = instances
    .filter((item) => item.status === "running" && item.adbPort)
    .map((item) => {
      const key = item.host ? `${item.host}:${item.adbPort}` : String(item.adbPort);
      return `<option value="${key}">${item.name} (:${item.adbPort})</option>`;
    })
    .join("");
  if ([...automationDevice.options].some((option) => option.value === selectedAutomationPort)) {
    automationDevice.value = selectedAutomationPort;
  }
  tbody.innerHTML = "";
  for (const inst of instances) {
    const tr = document.createElement("tr");
    const statusCls = inst.status === "running" ? "status-running" : "status-stopped";
    const booted = inst.status === "running" ? (inst.booted ? " · booted" : " · booting…") : "";
    tr.innerHTML = `
      <td>${inst.name}</td>
      <td>${inst.kind === "emulator" ? "VM KVM" : "Contenedor"}</td>
      <td>${inst.androidVersion}${inst.gapps ? " · GApps" : ""}</td>
      <td class="${statusCls}">${inst.status}${booted}</td>
      <td>${inst.adbPort ?? "-"}${inst.host ? ` @${inst.host}` : ""}</td>
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
        if (inst.host) query.set("host", inst.host);
        window.open(`http://127.0.0.1:8090/open?${query}`, "_blank");
      }, !inst.adbPort);
      if (inst.managed !== false) btn("Stop", "secondary", () => api(`/api/instances/${inst.id}/stop`));
    } else {
      btn("Start", "secondary", () => api(`/api/instances/${inst.id}/start`));
    }
    if (inst.managed !== false) {
      btn("Delete", "danger", () => {
        if (confirm(`Delete ${inst.name}?`)) return api(`/api/instances/${inst.id}`, { method: "DELETE" });
      });
    }
    tbody.appendChild(tr);
  }
  if (!instances.length) {
    tbody.innerHTML = `<tr><td colspan="6">No redroid containers found.</td></tr>`;
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
    host: inst.host,
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
  const ports = [...shareTargets.querySelectorAll("input:checked")].map((input) => input.value);
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

async function automate(action, selector = automationSelector.value, value = automationValue.value) {
  const key = automationDevice.value;
  const inst = currentInstances.find((i) => (i.host ? `${i.host}:${i.adbPort}` : String(i.adbPort)) === key);
  if (!inst) throw new Error("Select a running Android.");
  const hostParam = inst.host ? `?host=${encodeURIComponent(inst.host)}` : "";
  const response = await fetch(`/api/automation/${inst.adbPort}${hostParam}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, selector: selector ? { resourceId: selector } : {}, value }),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || response.statusText);
  return result;
}

async function remoteAction(body) {
  const key = automationDevice.value;
  const inst = currentInstances.find((i) => (i.host ? `${i.host}:${i.adbPort}` : String(i.adbPort)) === key);
  const hostParam = inst?.host ? `?host=${encodeURIComponent(inst.host)}` : "";
  const response = await fetch(`/api/automation/${inst.adbPort}${hostParam}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || response.statusText);
  automationResult.textContent = `${body.action} sent successfully.`;
}

document.getElementById("automation-inspect").onclick = async () => {
  automationResult.textContent = "Inspecting screen…";
  try {
    const result = await automate("inspect", "", "");
    automationResult.textContent = `${result.nodes.length} elements found.`;
    automationTbody.innerHTML = "";
    for (const node of result.nodes) {
      const row = document.createElement("tr");
      const label = node.text || node.description || "-";
      row.innerHTML = `<td></td><td></td><td></td><td></td>`;
      row.children[0].textContent = label;
      row.children[1].textContent = node.resourceId || "-";
      row.children[2].textContent = node.className.split(".").pop();
      if (node.resourceId) {
        const select = document.createElement("button");
        select.className = "secondary";
        select.textContent = "Select";
        select.onclick = () => {
          automationSelector.value = node.resourceId;
          if (node.text) automationValue.value = node.text;
        };
        row.children[3].appendChild(select);
      }
      automationTbody.appendChild(row);
    }
  } catch (error) {
    automationResult.textContent = `ERROR: ${error.message}`;
  }
};

document.getElementById("automation-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await automate("setText");
    automationResult.textContent = "Text entered successfully.";
  } catch (error) {
    automationResult.textContent = `ERROR: ${error.message}`;
  }
};

document.getElementById("automation-click").onclick = async () => {
  try {
    await automate("click");
    automationResult.textContent = "Element clicked successfully.";
  } catch (error) {
    automationResult.textContent = `ERROR: ${error.message}`;
  }
};

const remoteX = document.getElementById("remote-x");
const remoteY = document.getElementById("remote-y");
document.querySelectorAll("[data-move]").forEach((button) => {
  button.onclick = () => {
    const [dx, dy] = button.dataset.move.split(",").map(Number);
    remoteX.value = Math.max(0, Math.min(720, Number(remoteX.value) + dx));
    remoteY.value = Math.max(0, Math.min(1280, Number(remoteY.value) + dy));
  };
});
document.getElementById("remote-tap").onclick = () =>
  remoteAction({ action: "tap", x: Number(remoteX.value), y: Number(remoteY.value) }).catch((error) => automationResult.textContent = `ERROR: ${error.message}`);
document.querySelectorAll("[data-key]").forEach((button) => {
  button.onclick = () => remoteAction({ action: "press", key: button.dataset.key }).catch((error) => automationResult.textContent = `ERROR: ${error.message}`);
});
document.querySelectorAll("[data-swipe]").forEach((button) => {
  button.onclick = () => {
    const x = Number(remoteX.value);
    const y = Number(remoteY.value);
    const dy = button.dataset.swipe === "up" ? -300 : 300;
    remoteAction({ action: "swipe", x1: x, y1: y, x2: x, y2: Math.max(0, Math.min(1280, y + dy)) })
      .catch((error) => automationResult.textContent = `ERROR: ${error.message}`);
  };
});

document.getElementById("f-type").onchange = (e) => {
  document.getElementById("f-version-label").style.display = e.target.value === "emulator" ? "none" : "";
  portInput.value = e.target.value === "emulator" ? suggestEmulatorPort(currentInstances) : suggestPort(currentInstances);
};

createForm.onsubmit = async (e) => {
  e.preventDefault();
  const type = document.getElementById("f-type").value;
  const body = {
    name: document.getElementById("f-name").value.trim(),
    type,
    port: Number(portInput.value),
  };
  if (type !== "emulator") body.androidVersion = document.getElementById("f-version").value;
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
    tbody.innerHTML = `<tr><td colspan="6">JavaScript error: ${event.message}</td></tr>`;
  }
});

refresh();
setInterval(() => { if (!screenView.classList.contains("hidden")) return; refresh(); }, 5000);
