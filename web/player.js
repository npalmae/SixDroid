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
  constructor({ canvas, adbPort, onStatus }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.adbPort = adbPort;
    this.onStatus = onStatus || (() => {});
    this.decoder = null;
    this.meta = null;
    this.configSeen = false;
    this.stopped = false;
    this.boundKeys = [];
  }

  status(s) { this.onStatus(s); }

  start() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.streamWs = new WebSocket(`${proto}://${location.host}/ws/stream/${this.adbPort}`);
    this.streamWs.binaryType = "arraybuffer";
    this.controlWs = new WebSocket(`${proto}://${location.host}/ws/control/${this.adbPort}`);
    this.streamWs.onopen = () => this.status("connecting…");
    this.streamWs.onmessage = (e) => this.handlePacket(new Uint8Array(e.data));
    this.streamWs.onclose = (e) => {
      if (!this.stopped) {
        this.status(`disconnected (${e.reason || e.code}), retrying in 2s`);
        setTimeout(() => !this.stopped && this.start(), 2000);
      }
    };
    this.streamWs.onerror = () => {};
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
        // reconnect: scrcpy will re-send a keyframe
        try { this.streamWs?.close(); } catch {}
      },
    });
    this.decoder.configure({
      codec: "avc1.42E01E", // H264 baseline; annexb data carries SPS/PPS anyway
      hardwareAcceleration: "prefer-hardware",
      optimizeForLatency: true,
    });
    this.status("streaming");
  }

  handlePacket(bytes) {
    const kind = bytes[0];
    if (kind === 0x00) {
      this.meta = JSON.parse(new TextDecoder().decode(bytes.subarray(1)));
      this.status(`streaming ${this.meta.width}x${this.meta.height}`);
      return;
    }
    if (kind === 0x02) {
      // configuration packet (SPS/PPS, annexb) — decode as a key chunk
      this.configSeen = true;
      this.initDecoder();
      this.decode(bytes.subarray(1), true, 0);
      return;
    }
    if (kind === 0x01) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const keyframe = (view.getUint8(1) & 1) !== 0;
      const pts = view.getBigInt64(2, false);
      this.initDecoder();
      this.decode(bytes.subarray(10), keyframe, pts < 0n ? undefined : pts);
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
    }
  }

  sendControl(msg) {
    if (this.controlWs?.readyState === WebSocket.OPEN) {
      this.controlWs.send(JSON.stringify(msg));
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
