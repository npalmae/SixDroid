// Screen streaming (WebCodecs H264 annexb) + input control over WebSocket.

const KEYCODE = {
  AndroidBack: 4, AndroidHome: 3, VolumeUp: 24, VolumeDown: 25, Power: 26,
  ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22, Enter: 66, Delete: 67,
};

// Browser KeyboardEvent.code -> Android keyCode (common keys; letters/digits are
// KeyA=29..KeyZ=54, Digit0=7..Digit9=16)
function mapKey(e) {
  switch (e.code) {
    case "Escape": return KEYCODE.AndroidBack;
    case "Home": return KEYCODE.AndroidHome;
    case "AudioVolumeUp": case "F11": return KEYCODE.VolumeUp;
    case "AudioVolumeDown": case "F10": return KEYCODE.VolumeDown;
    case "ArrowUp": return KEYCODE.ArrowUp;
    case "ArrowDown": return KEYCODE.ArrowDown;
    case "ArrowLeft": return KEYCODE.ArrowLeft;
    case "ArrowRight": return KEYCODE.ArrowRight;
    case "Enter": return KEYCODE.Enter;
    case "Backspace": return KEYCODE.Delete;
  }
  let m = e.code.match(/^Key([A-Z])$/);
  if (m) return 29 + (m[1].charCodeAt(0) - 65);
  m = e.code.match(/^Digit([0-9])$/);
  if (m) return 7 + Number(m[1]);
  return null;
}

export class ScreenPlayer {
  constructor({ canvas, adbPort, host, onStatus, onLog }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.adbPort = adbPort;
    this.host = host || "";
    this.onStatus = onStatus || (() => {});
    this.onLog = onLog || (() => {});
    this.decoder = null;
    this.meta = null;
    this.configSeen = false;
    this.codecConfig = null;
    this.stopped = false;
    this.boundKeys = [];
    this.packetCount = 0;
  }

  status(s) { this.onStatus(s); }
  log(s) { this.onLog(s); }

  start() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const suffix = this.host ? `?host=${encodeURIComponent(this.host)}` : "";
    this.log(`opening stream websocket /ws/stream/${this.adbPort}${suffix}`);
    this.log(`opening control websocket /ws/control/${this.adbPort}${suffix}`);
    this.streamWs = new WebSocket(`${proto}://${location.host}/ws/stream/${this.adbPort}${suffix}`);
    this.streamWs.binaryType = "arraybuffer";
    this.controlWs = new WebSocket(`${proto}://${location.host}/ws/control/${this.adbPort}${suffix}`);
    this.streamWs.onopen = () => {
      this.status("connecting…");
      this.log("stream websocket connected");
    };
    this.controlWs.onopen = () => this.log("control websocket connected");
    this.controlWs.onmessage = (event) => {
      const result = JSON.parse(event.data);
      if (!result.ok) this.log(`control failed: ${result.error}`);
      else if (result.action !== "move") this.log(`control acknowledged: ${result.type} ${result.action || ""}`);
    };
    this.controlWs.onerror = () => this.log("control websocket error");
    this.controlWs.onclose = (e) => this.log(`control websocket closed: ${e.code} ${e.reason || ""}`);
    this.streamWs.onmessage = (e) => {
      const bytes = new Uint8Array(e.data);
      this.packetCount++;
      if (this.packetCount <= 5 || this.packetCount % 100 === 0) {
        this.log(`packet #${this.packetCount} type=0x${bytes[0].toString(16).padStart(2, "0")} bytes=${bytes.length}`);
      }
      this.handlePacket(bytes);
    };
    this.streamWs.onclose = (e) => {
      if (!this.stopped) {
        this.log(`stream websocket closed: ${e.code} ${e.reason || ""}`);
        this.status(`disconnected (${e.reason || e.code}), retrying in 2s`);
        setTimeout(() => !this.stopped && this.start(), 2000);
      }
    };
    this.streamWs.onerror = () => this.log("stream websocket error");
    this.attachInput();
  }

  stop() {
    this.stopped = true;
    try { this.streamWs?.close(); } catch {}
    try { this.controlWs?.close(); } catch {}
    try { this.decoder?.close(); } catch {}
    this.decoder = null;
    for (const [t, ev, fn, o] of this.boundKeys) t.removeEventListener(ev, fn, o);
    this.boundKeys = [];
  }

  initDecoder() {
    if (this.decoder) return;
    if (!("VideoDecoder" in window)) {
      const message = `WebCodecs VideoDecoder is unavailable in this browser (${navigator.userAgent})`;
      this.status("browser not supported");
      this.log(message);
      throw new Error(message);
    }
    this.decoder = new VideoDecoder({
      output: (frame) => {
        if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
          this.canvas.width = frame.displayWidth;
          this.canvas.height = frame.displayHeight;
        }
        this.ctx.drawImage(frame, 0, 0);
        frame.close();
      },
      error: (err) => {
        console.error("decoder error", err);
        this.log(`decoder error: ${err.message || err}`);
        // reconnect: scrcpy will re-send a keyframe
        try { this.streamWs?.close(); } catch {}
      },
    });
    try {
      this.decoder.configure({
        codec: "avc1.42E01E", // H264 baseline; annexb data carries SPS/PPS anyway
        hardwareAcceleration: "prefer-hardware",
        optimizeForLatency: true,
      });
    } catch (error) {
      this.status("decoder unavailable");
      this.log(`VideoDecoder configure failed: ${error.message || error}`);
      throw error;
    }
    this.log("WebCodecs decoder configured: avc1.42E01E");
    this.status("streaming");
  }

  handlePacket(bytes) {
    const kind = bytes[0];
    if (kind === 0x00) {
      this.meta = JSON.parse(new TextDecoder().decode(bytes.subarray(1)));
      this.log(`metadata: ${JSON.stringify(this.meta)}`);
      this.status(`streaming ${this.meta.width}x${this.meta.height}`);
      return;
    }
    if (kind === 0x02) {
      // Keep Annex B SPS/PPS and prepend it to the first IDR frame. WebCodecs
      // requires the first chunk after configure() to be a complete keyframe.
      this.configSeen = true;
      this.codecConfig = bytes.slice(1);
      this.log(`H264 configuration received (${bytes.length - 1} bytes)`);
      this.initDecoder();
      return;
    }
    if (kind === 0x01) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const keyframe = (view.getUint8(1) & 1) !== 0;
      const pts = view.getBigInt64(2, false);
      this.initDecoder();
      let data = bytes.subarray(10);
      if (keyframe && this.codecConfig) {
        const completeKeyframe = new Uint8Array(this.codecConfig.length + data.length);
        completeKeyframe.set(this.codecConfig);
        completeKeyframe.set(data, this.codecConfig.length);
        data = completeKeyframe;
        this.codecConfig = null;
        this.log(`decoding first complete keyframe (${data.length} bytes)`);
      }
      this.decode(data, keyframe, pts < 0n ? undefined : pts);
    }
  }

  decode(data, keyframe, timestamp) {
    if (this.decoder.state !== "configured") return;
    try {
      this.decoder.decode(new EncodedVideoChunk({
        type: keyframe ? "key" : "delta",
        timestamp: timestamp === undefined ? performance.now() * 1000 : Number(timestamp),
        data,
      }));
    } catch (e) {
      console.error("decode error", e);
      this.log(`decode exception: ${e.message || e}`);
    }
  }

  sendControl(msg) {
    if (this.controlWs?.readyState === WebSocket.OPEN) {
      this.controlWs.send(JSON.stringify(msg));
      if (msg.action !== "move") this.log(`control sent: ${msg.type} ${msg.action || ""}`);
    } else {
      this.log(`control not sent: websocket state ${this.controlWs?.readyState ?? "missing"}`);
    }
  }

  attachInput() {
    const on = (target, ev, fn, opts) => {
      target.addEventListener(ev, fn, opts);
      this.boundKeys.push([target, ev, fn, opts]);
    };
    const c = this.canvas;
    let down = false;
    const pos = (e) => {
      const r = c.getBoundingClientRect();
      return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    };
    on(c, "pointerdown", (e) => {
      down = true;
      c.setPointerCapture(e.pointerId);
      this.sendControl({ type: "touch", action: "down", ...pos(e) });
      e.preventDefault();
    });
    on(c, "pointermove", (e) => {
      if (down) this.sendControl({ type: "touch", action: "move", ...pos(e) });
    });
    const up = (e) => {
      if (!down) return;
      down = false;
      this.sendControl({ type: "touch", action: "up", ...pos(e) });
    };
    on(c, "pointerup", up);
    on(c, "pointercancel", up);
    on(window, "keydown", (e) => {
      const keyCode = mapKey(e);
      if (keyCode == null || e.repeat) return;
      this.sendControl({ type: "key", action: "down", keyCode });
      e.preventDefault();
    });
    on(window, "keyup", (e) => {
      const keyCode = mapKey(e);
      if (keyCode == null) return;
      this.sendControl({ type: "key", action: "up", keyCode });
      e.preventDefault();
    });
  }
}
