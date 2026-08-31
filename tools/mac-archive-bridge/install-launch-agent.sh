#!/bin/bash
# تثبيت خدمتَي الماك اللتين تعملان تلقائياً عند تسجيل دخول المستخدم:
#
#   com.ozk.archive-bridge  جسر الأرشفة إلى iCloud (127.0.0.1:8787)
#   com.ozk.local-site      نسخة الموقع محلياً    (127.0.0.1:5173)
#
# لماذا نسخة محلية؟ لأن فتح الموقع من أصل محلي يجعل الأرشفة تعمل بلا أي إذن
# شبكة محلية من المتصفح. راجع docs/ai/topics/icloud-archive.md للقياسات.
#
# الاستعمال:
#   bash tools/mac-archive-bridge/install-launch-agent.sh              # الاثنتان
#   bash tools/mac-archive-bridge/install-launch-agent.sh --bridge-only
#   bash tools/mac-archive-bridge/install-launch-agent.sh --uninstall
#
# لا يلمس السكربت أي شيء خارج LaunchAgents الخاص بالمستخدم و~/OZK-Archive-Bridge.

set -euo pipefail

BRIDGE_LABEL="com.ozk.archive-bridge"
SITE_LABEL="com.ozk.local-site"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
SERVER="$SCRIPT_DIR/server.mjs"
SITE_SERVER="$REPO_DIR/scripts/serve.mjs"
AGENT_DIR="$HOME/Library/LaunchAgents"
DATA_DIR="${OZK_ARCHIVE_HOME:-$HOME/OZK-Archive-Bridge}"
LOG_DIR="$DATA_DIR/logs"
SITE_PORT="${OZK_SITE_PORT:-5173}"

remove_agent() {
  local label="$1"
  local plist="$AGENT_DIR/$label.plist"
  if [ -f "$plist" ]; then
    launchctl bootout "gui/$UID/$label" 2>/dev/null || launchctl unload -w "$plist" 2>/dev/null || true
    rm -f "$plist"
    echo "✅ أُزيلت: $label"
  fi
}

if [ "${1:-}" = "--uninstall" ]; then
  remove_agent "$BRIDGE_LABEL"
  remove_agent "$SITE_LABEL"
  echo "الملفات المؤرشفة والسجلات لم تُمس."
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

# يكتب plist ثم يعيد تحميله. مجلد العمل خارج ~/Documents عمداً: قياس فعلي
# (2026-08-31) أن LaunchAgent بمجلد عمل داخل ~/Documents يتجمّد عند getcwd
# أثناء إقلاع Node ولا يصل إلى الاستماع إطلاقاً. قراءة ملفات المستودع نفسها
# تعمل بلا مشكلة، ولا يؤثر مجلد العمل على حلّ node_modules.
write_agent() {
  local label="$1" script="$2" extra_env="$3"
  local plist="$AGENT_DIR/$label.plist"
  cat > "$plist" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$script</string>
  </array>
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
  <string>$LOG_DIR/$label.out.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/$label.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin</string>
    <key>OZK_ARCHIVE_HOME</key>
    <string>$DATA_DIR</string>
$extra_env
  </dict>
</dict>
</plist>
PLIST_EOF
  launchctl bootout "gui/$UID/$label" 2>/dev/null || true
  # launchd يحتاج لحظة ليحرّر التسمية بعد bootout، وإلا فشل bootstrap بـ«Input/output error».
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    launchctl print "gui/$UID/$label" >/dev/null 2>&1 || break
    sleep 0.3
  done
  launchctl bootstrap "gui/$UID" "$plist" 2>/dev/null || launchctl load -w "$plist" 2>/dev/null || true
  launchctl kickstart -k "gui/$UID/$label" 2>/dev/null || true
  echo "✅ ثُبّتت: $label"
}

write_agent "$BRIDGE_LABEL" "$SERVER" ""

if [ "${1:-}" != "--bridge-only" ]; then
  if [ -f "$SITE_SERVER" ]; then
    # HOST=127.0.0.1 يحصر الموقع على الاسترجاع: لا يُعرَض على الشبكة من الماك
    # إطلاقاً، بخلاف تشغيله على ويندوز الذي يبقى 0.0.0.0 كما كان.
    write_agent "$SITE_LABEL" "$SITE_SERVER" "    <key>HOST</key>
    <string>127.0.0.1</string>
    <key>PORT</key>
    <string>$SITE_PORT</string>"
  else
    echo "⚠️  لم أجد $SITE_SERVER — تُرك مرافق الموقع المحلي بلا تثبيت."
  fi
fi

echo
echo "node:   $NODE_BIN"
echo "السجل:  $LOG_DIR/"
echo
echo "تحقق سريع:"
echo "  curl -s -H 'Origin: http://127.0.0.1:$SITE_PORT' http://127.0.0.1:8787/health"
echo "  افتح في Chrome:  http://127.0.0.1:$SITE_PORT"
