// Instance list management + view switching
import { ScreenPlayer } from "./player.js";

const tbody = document.querySelector("#instances-table tbody");
const createForm = document.getElementById("create-form");
const portInput = document.getElementById("f-port");
const instancesView = document.getElementById("instances-view");
const screenView = document.getElementById("screen-view");
const screenTitle = document.getElementById("screen-title");
const screenStatus = document.getElementById("screen-status");
const canvas = document.getElementById("screen-canvas");

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
  tbody.innerHTML = "";
  for (const inst of instances) {
    const tr = document.createElement("tr");
    const statusCls = inst.status === "running" ? "status-running" : "status-stopped";
    const booted = inst.status === "running" ? (inst.booted ? " · booted" : " · booting…") : "";
    tr.innerHTML = `
      <td>${inst.name}</td>
      <td>${inst.androidVersion}</td>
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

function openScreen(inst) {
  instancesView.classList.add("hidden");
  screenView.classList.remove("hidden");
  screenTitle.textContent = `${inst.name} (Android ${inst.androidVersion}, :${inst.adbPort})`;
  player = new ScreenPlayer({
    canvas,
    adbPort: inst.adbPort,
    onStatus: (s) => (screenStatus.textContent = s),
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

refresh();
setInterval(() => { if (!screenView.classList.contains("hidden")) return; refresh(); }, 5000);
