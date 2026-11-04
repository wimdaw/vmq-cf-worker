#!/usr/bin/env bash
#
# macOS 安装脚本：launchd 托管。
#
#   sudo ./install.sh                # LaunchDaemon：开机就跑，不需要登录（推荐）
#        ./install.sh --user         # LaunchAgent：用户登录后跑，能弹桌面通知
#
# 前提：当前目录上有 build.sh 产出的 vmq-agent-darwin-<arch>。
set -euo pipefail

MODE="daemon"
[ "${1:-}" = "--user" ] && MODE="agent"

ARCH="${ARCH:-$(uname -m)}"
[ "$ARCH" = "aarch64" ] && ARCH="arm64"
BIN_SRC="../../dist/vmq-agent-darwin-${ARCH}"
BIN_DST="/usr/local/bin/vmq-agent"
LABEL="com.vmq.agent"
PLIST_SRC="../darwin/com.vmq.agent.plist"

[ -f "$BIN_SRC" ] || { echo "找不到 $BIN_SRC，请先执行 agent/scripts/build.sh" >&2; exit 1; }

if [ "$MODE" = "daemon" ]; then
  [ "$(id -u)" -eq 0 ] || { echo "LaunchDaemon 需要 root：sudo ./install.sh" >&2; exit 1; }
  CFG_DIR="/usr/local/etc/vmq-agent"
  PLIST_DST="/Library/LaunchDaemons/${LABEL}.plist"
  LOG="/usr/local/var/log/vmq-agent.log"
else
  CFG_DIR="$HOME/Library/Application Support/vmq-agent"
  PLIST_DST="$HOME/Library/LaunchAgents/${LABEL}.plist"
  LOG="$HOME/Library/Logs/vmq-agent.log"
fi
CFG="${CFG_DIR}/config.json"

# 1) 二进制
if [ "$MODE" = "daemon" ]; then
  install -m 0755 "$BIN_SRC" "$BIN_DST"
else
  mkdir -p "$(dirname "$BIN_DST")" 2>/dev/null || true
  install -m 0755 "$BIN_SRC" "$BIN_DST" 2>/dev/null || {
    BIN_DST="$HOME/.local/bin/vmq-agent"
    mkdir -p "$(dirname "$BIN_DST")"
    install -m 0755 "$BIN_SRC" "$BIN_DST"
  }
fi
echo "已安装 $BIN_DST"

# 2) 配置（已存在则不覆盖）
mkdir -p "$CFG_DIR"
if [ -f "$CFG" ]; then
  echo "配置已存在，保留原文件：$CFG"
else
  "$BIN_DST" -init -config "$CFG" >/dev/null
  chmod 0600 "$CFG"
  echo "已生成示例配置：$CFG（请填写 server.base_url 与 server.token）"
fi

# 3) plist
mkdir -p "$(dirname "$PLIST_DST")" "$(dirname "$LOG")"
sed -e "s|__BIN__|$BIN_DST|g" -e "s|__CFG__|$CFG|g" -e "s|__LOG__|$LOG|g" \
  "$PLIST_SRC" > "$PLIST_DST"

# 覆盖安装时先卸载旧的，否则 launchctl 会拒绝重复 load
launchctl bootout "system/${LABEL}" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true

if [ "$MODE" = "daemon" ]; then
  chown root:wheel "$PLIST_DST"
  chmod 0644 "$PLIST_DST"
  launchctl bootstrap system "$PLIST_DST"
else
  chmod 0644 "$PLIST_DST"
  launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
fi

cat <<EOF

已启动（${MODE}）。常用命令：
  launchctl print $([ "$MODE" = daemon ] && echo "system" || echo "gui/$(id -u)")/${LABEL} | head -30
  tail -f "$LOG"
  "$BIN_DST" -check -config "$CFG"

改了配置后：launchctl kickstart -k $([ "$MODE" = daemon ] && echo "system" || echo "gui/$(id -u)")/${LABEL}
EOF
