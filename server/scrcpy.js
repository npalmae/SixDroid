/**
 * scrcpy.js — ALL Tango (@yume-chan/*) usage is isolated in this file.
 *
 * Wire protocol towards the browser (binary WS messages):
 *   [0x00][json utf-8]  -> stream metadata: {deviceName, width, height, codec}
 *   [0x01][flags(1)][pts(8, BE, signed)][h264 annexb payload...]
 *       flags bit 0 = keyframe. pts in microseconds, -1 if unknown.
 *   [0x02][h264 annexb config (SPS/PPS)...]  -> configuration packet
 */
import fs from "node:fs";
import { Readable } from "node:stream";
import { AdbScrcpyClient, AdbScrcpyOptionsLatest } from "@yume-chan/adb-scrcpy";
import {
  AndroidMotionEventAction,
  AndroidMotionEventButton,
  AndroidKeyEventAction,
  AndroidKeyEventMeta,
  ScrcpyVideoCodecId,
} from "@yume-chan/scrcpy";

const SERVER_PATH = process.env.SCRCPY_SERVER_PATH || new URL("../scrcpy-server.bin", import.meta.url).pathname;
const SERVER_DEVICE_PATH = "/data/local/tmp/sixdroid-scrcpy-server.jar";

const ACTION_MAP = {
  down: AndroidMotionEventAction.Down,
  up: AndroidMotionEventAction.Up,
  move: AndroidMotionEventAction.Move,
};

export class ScrcpySession {
  /** @param {import("@yume-chan/adb").Adb} adb @param {number} adbPort */
  constructor(adb, adbPort) {
    this.adb = adb;
    this.adbPort = adbPort;
    this.client = undefined;
    this.width = 0;
    this.height = 0;
    this.onPacket = undefined; // (Buffer) => void, binary message for browser
    this.onClose = undefined;
  }

  async start() {
    // push scrcpy-server jar once (pushServer throws if file exists? it just overwrites)
    const fileStream = Readable.toWeb(fs.createReadStream(SERVER_PATH));
    await AdbScrcpyClient.pushServer(this.adb, fileStream, SERVER_DEVICE_PATH);

    const options = new AdbScrcpyOptionsLatest({
      video: true,
      audio: false,
      control: true,
      videoCodec: "h264",
      maxSize: 1280,
      // software encoder works on redroid (no HW encoders)
      videoEncoder: "OMX.google.h264.encoder",
      powerOn: true,
      clipboardAutosync: false,
      sendDeviceMeta: true,
      sendCodecMeta: true,
      sendFrameMeta: true,
      sendDummyByte: true,
    });

    this.client = await AdbScrcpyClient.start(this.adb, SERVER_DEVICE_PATH, options);

    const video = await this.client.videoStream;
    if (!video) throw new Error("scrcpy did not provide a video stream");

    this.width = video.width || 0;
    this.height = video.height || 0;

    // metadata message
    const meta = {
      deviceName: video.metadata.deviceName,
      width: this.width,
      height: this.height,
      codec: video.metadata.codec === ScrcpyVideoCodecId.H264 ? "h264" : "other",
    };
    this.onPacket?.(Buffer.concat([Buffer.from([0x00]), Buffer.from(JSON.stringify(meta), "utf8")]));

    // consume video packets
    const reader = video.stream.getReader();
    try {
      while (true) {
        const { done, value: packet } = await reader.read();
        if (done) break;
        if (packet.type === "configuration") {
          // SPS/PPS in annexb
          this.onPacket?.(Buffer.concat([Buffer.from([0x02]), Buffer.from(packet.data)]));
        } else {
          const flags = packet.keyframe ? 1 : 0;
          const pts = packet.pts ?? -1n;
          const header = Buffer.allocUnsafe(10);
          header.writeUInt8(0x01, 0);
          header.writeUInt8(flags, 1);
          header.writeBigInt64BE(pts, 2);
          this.onPacket?.(Buffer.concat([header, Buffer.from(packet.data)]));
        }
      }
    } finally {
      reader.releaseLock();
    }

    this.client.exited.then(() => this.onClose?.()).catch(() => this.onClose?.());
  }

  get controller() {
    return this.client?.controller;
  }

  /** @param {{action:'down'|'up'|'move', x:number, y:number}} msg normalized 0..1 coords */
  async injectTouch(msg) {
    const controller = this.controller;
    if (!controller || !this.width || !this.height) return;
    await controller.injectTouch({
      action: ACTION_MAP[msg.action] ?? AndroidMotionEventAction.Move,
      pointerId: 1n,
      pointerX: Math.round(msg.x * this.width),
      pointerY: Math.round(msg.y * this.height),
      videoWidth: this.width,
      videoHeight: this.height,
      pressure: msg.action === "up" ? 0 : 1,
      actionButton: AndroidMotionEventButton.Primary,
      buttons: msg.action === "up" ? AndroidMotionEventButton.None : AndroidMotionEventButton.Primary,
    });
  }

  /** @param {{action:'down'|'up', keyCode:number, metaState?:number}} msg */
  async injectKey(msg) {
    const controller = this.controller;
    if (!controller) return;
    await controller.injectKeyCode({
      action: msg.action === "down" ? AndroidKeyEventAction.Down : AndroidKeyEventAction.Up,
      keyCode: msg.keyCode,
      repeat: 0,
      metaState: msg.metaState ?? AndroidKeyEventMeta.None,
    });
  }

  async injectText(text) {
    await this.controller?.injectText(text);
  }

  async close() {
    try {
      await this.client?.close();
    } catch {
      /* ignore */
    }
  }
}
