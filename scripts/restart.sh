#!/usr/bin/env bash
# VRouter geliştirme yardımcısı: sunucuyu güvenli yeniden başlatır
cd /home/dante/Project/VRouter || exit 1

PID_FILE=/tmp/vrouter.pid

if [ -f "$PID_FILE" ]; then
  OLD=$(cat "$PID_FILE" 2>/dev/null)
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then
    kill "$OLD" 2>/dev/null
    sleep 1
    kill -9 "$OLD" 2>/dev/null
  fi
  rm -f "$PID_FILE"
fi

# portu tutan başka süreç varsa onu da serbest bırak
for pid in $(ss -lptn 'sport = :10090' 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u); do
  kill "$pid" 2>/dev/null
done
sleep 1

setsid node src/index.js > /tmp/vrouter.log 2>&1 < /dev/null &
echo $! > "$PID_FILE"

for i in $(seq 1 30); do
  if curl -sf http://localhost:10090/health > /dev/null 2>&1; then
    echo "VRouter hazır (pid $(cat $PID_FILE))"
    exit 0
  fi
  sleep 0.5
done

echo "Başlatılamadı:"
tail -20 /tmp/vrouter.log
exit 1
