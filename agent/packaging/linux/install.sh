#!/usr/bin/env bash
#
# Linux 安装脚本：systemd 托管。
#
#   sudo ./install.sh                      # 默认装 x86_64 版本
#   sudo ARCH=arm64 ./install.sh
#
# 前提：当前目录下有 build.sh 产出的 vmq-agent-linux-<arch>。
set -euo pipefail

ARCH="${ARCH:-amd64}"
BIN_SRC="../../dist/vmq-agent-linux-${ARCH}"
BIN_DST="/usr/local/bin/vmq-agent"
CFG_DIR="/etc/vmq-agent"
CFG="${CFG_DIR}/config.json"
UNIT_SRC="../linux/vmq-agent.service"
UNIT_DST="/etc/systemd/system/vmq-agent.service"
SVC_USER="vmq-agent"

[ "$(id -u)" -eq 0 ] || { echo "请用 root 运行（sudo）" >&2; exit 1; }
[ -f "$BIN_SRC" ] || { echo "找不到 $BIN_SRC，请先执行 agent/scripts/build.sh" >&2; exit 1; }

# 1) 专用用户：采集系统指标不需要 root，能不用就不用
if ! id "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
  echo "已创建系统用户 $SVC_USER"
fi

# 2) 二进制
install -m 0755 "$BIN_SRC" "$BIN_DST"
echo "已安装 $BIN_DST"

# 3) 配置（已存在则不覆盖，避免冲掉线上令牌）
install -d -m 0750 "$CFG_DIR"
if [ -f "$CFG" ]; then
  echo "配置已存在，保留原文件：$CFG"
else
  "$BIN_DST" -init -config "$CFG" >/dev/null
  chown root:"$SVC_USER" "$CFG"
  chmod 0640 "$CFG"
  echo "已生成示例配置：$CFG（请填写 server.base_url 与 server.token）"
fi

# 4) systemd
install -m 0644 "$UNIT_SRC" "$UNIT_DST"
systemctl daemon-reload
systemctl enable --now vmq-agent.service

cat <<'EOF'

已启动。常用命令：
  systemctl status vmq-agent
  journalctl -u vmq-agent -f
  /usr/local/bin/vmq-agent -check -config /etc/vmq-agent/config.json

改了配置后：systemctl restart vmq-agent
EOF
