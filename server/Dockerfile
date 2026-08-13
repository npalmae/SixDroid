FROM node:20-bookworm-slim

# adb (android-tools-adb) lets us run `adb start-server` + `adb connect` inside the container
RUN apt-get update \
  && apt-get install -y --no-install-recommends adb \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY server/package.json server/package-lock.json* ./
RUN npm install --omit=dev

# Download scrcpy-server jar (v3.3.3) used by AdbScrcpyClient.pushServer
RUN npx fetch-scrcpy-server 3.3.3 \
  && cp node_modules/@yume-chan/fetch-scrcpy-server/server.bin /app/scrcpy-server.bin

COPY server/ .
COPY web/ /web/

ENV PORT=8080 \
    DEVICE_HOST=10.141.10.152 \
    SCRCPY_SERVER_PATH=/app/scrcpy-server.bin

EXPOSE 8080

# Start adb server, then the panel
CMD ["sh", "-c", "adb start-server && node index.js"]
