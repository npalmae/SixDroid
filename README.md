# SixDroid

Web panel MVP to manage [redroid](https://github.com/remote-android/redroid-doc) Android containers
and stream their screens into the browser (H264 over WebSocket, decoded with WebCodecs).

## Architecture

- `server/` — Node.js 20 (ESM), Express 4 + dockerode + ws
  - Talks to Docker via the mounted `/var/run/docker.sock` to list/create/start/stop/delete redroid containers.
  - An `adb` server runs **inside** the container (android-tools-adb). Per device it lazily runs
    `adb connect $DEVICE_HOST:<port>` and uses Tango (`@yume-chan/adb`, `@yume-chan/adb-server-node-tcp`,
    `@yume-chan/adb-scrcpy`) to push and start a scrcpy server (v3.3.3, fetched at image build time).
  - Video (H264, maxSize 1280, no audio) is forwarded to the browser as binary WebSocket messages;
    touches/keys come back on a second WebSocket and are injected with scrcpy control messages.
  - All Tango API usage is isolated in `server/scrcpy.js`.
- `web/` — static frontend, plain HTML/JS ES modules, no build step, served by Express.
- `docker-compose.yml` — single `sixdroid` service.

## Run

```sh
DEVICE_HOST=10.141.10.152 docker compose up --build
```

Open http://localhost:8080

`DEVICE_HOST` must be the host IP reachable from inside the sixdroid container
(where redroid adb ports are published). Default: `10.141.10.152`.

## API

| Method | Path | Description |
|---|---|---|
| GET | `/api/instances` | list redroid containers (name, image, status, androidVersion, adbPort, booted) |
| POST | `/api/instances` | `{name, androidVersion, port}` → creates `sixdroid-<name>` from `redroid/redroid:<v>.0.0-latest` |
| POST | `/api/instances/:id/start` / `stop` | start/stop |
| DELETE | `/api/instances/:id` | remove (force) |
| WS | `/ws/stream/:adbPort` | binary video stream (`0x00`=meta JSON, `0x01`=video packet, `0x02`=SPS/PPS) |
| WS | `/ws/control/:adbPort` | JSON `{type:'touch'|'key'|'text', ...}` |

## Notes

- redroid has no hardware encoders, so the scrcpy session requests the software encoder
  `OMX.google.h264.encoder` (see `server/scrcpy.js`).
- Containers must be created with `--privileged` and publish container port 5555; the panel
  does this for containers it creates.
