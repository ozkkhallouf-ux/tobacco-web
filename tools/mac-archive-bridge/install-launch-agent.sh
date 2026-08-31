#!/bin/bash
# تثبيت جسر الأرشفة كخدمة تعمل تلقائياً عند تسجيل دخول مستخدم الماك.
#
# الاستعمال:
#   bash tools/mac-archive-bridge/install-launch-agent.sh            # تثبيت/تحديث
#   bash tools/mac-archive-bridge/install-launch-agent.sh --uninstall # إزالة
#
# لا يلمس السكربت أي شيء خارج LaunchAgents الخاص بالمستخدم و~/OZK-Archive-Bridge.

set -euo pipefail

LABEL="com.ozk.archive-bridge"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# REPO_DIR محفوظ للمرجع فقط
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
SERVER="$SCRIPT_DIR/server.mjs"
AGENT_DIR="$HOME/Library/LaunchAgents"
PLIST="$AGENT_DIR/$LABEL.plist"
DATA_DIR="${OZK_ARCHIVE_HOME:-$HOME/OZK-Archive-Bridge}"
LOG_DIR="$DATA_DIR/logs"

uninstall() {
  if [ -f "$PLIST" ]; then
    launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || launchctl unload -w "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "✅ أُزيلت الخدمة. الملفات المؤرشفة والسجلات لم تُمس."
  else
    echo "لا توجد خدمة مثبّتة."
  fi
}

if [ "${1:-}" = "--uninstall" ]; then
  uninstall
  exit 0
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "✗ لم أجد node في PATH. ثبّت Node.js ثم أعد المحاولة." >&2
  exit 1
fi
if [ ! -f "$SERVER" ]; then
  echo "✗ ملف الخادم غير موجود: $SERVER" >&2
  exit 1
fi

mkdir -p "$AGENT_DIR" "$LOG_DIR"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$SERVER</string>
  </array>
  <!-- مجلد العمل خارج ~/Documents عمداً: قياس فعلي على macOS 25 (2026-08-31) —
       LaunchAgent يُضبط مجلد عمله داخل ~/Documents يتجمّد عند getcwd أثناء
       إقلاع Node ولا يصل إلى الاستماع إطلاقاً (حارس خصوصية النظام يحجب chdir
       بلا رسالة). قراءة ملفات المستودع نفسها تعمل بلا مشكلة، ولا يؤثر مجلد
       العمل على حلّ node_modules لأنه يُحسب من موقع الوحدة لا من cwd. -->
  <key>WorkingDirectory</key>
  <string>$DATA_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/bridge.out.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/bridge.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin</string>
    <key>OZK_ARCHIVE_HOME</key>
    <string>$DATA_DIR</string>
  </dict>
</dict>
</plist>
PLIST_EOF

# إعادة التحميل: bootout ثم bootstrap هي الطريقة المعتمدة على macOS الحديثة.
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"
launchctl kickstart -k "gui/$UID/$LABEL" 2>/dev/null || true

echo "✅ ثُبّتت الخدمة: $LABEL"
echo "   node:   $NODE_BIN"
echo "   الخادم: $SERVER"
echo "   السجل:  $LOG_DIR/bridge.out.log"
echo
echo "تحقق سريع:"
echo "  curl -s -H 'Origin: https://ozktobacco.com' http://127.0.0.1:8787/health"
