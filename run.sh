#!/bin/bash
# 常駐啟動：伺服器當掉會在 2 秒後自動重啟。用法：nohup ./run.sh > server.log 2>&1 &
cd "$(dirname "$0")"
while true; do node server.js; echo "[run.sh] server exited ($?), restarting in 2s"; sleep 2; done
