#!/usr/bin/env bash
#
# 交叉编译三平台监控端。
#
# 产物是**纯静态单文件**（CGO_ENABLED=0），目标机器不需要装任何运行时 ——
# 这一点是刻意保留的：监控程序要在出问题的时候还能跑，
# 不能依赖「Node 还活着」「Python 还没被删」这类前提。
#
# 用法：
#   ./scripts/build.sh              # 版本号取 git describe
#   VERSION=1.2.0 ./scripts/build.sh
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="${VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}"
OUT="${OUT:-dist}"
GO="${GO:-go}"

command -v "$GO" >/dev/null 2>&1 || {
  echo "未找到 go，请先安装 Go 1.22+ 或设置 GO=/path/to/go" >&2
  exit 1
}

mkdir -p "$OUT"
echo "版本：$VERSION"
echo "输出：$OUT/"
echo

TARGETS=(
  linux/amd64
  linux/arm64
  darwin/amd64
  darwin/arm64
  windows/amd64
  windows/arm64
)

for target in "${TARGETS[@]}"; do
  os="${target%%/*}"
  arch="${target##*/}"
  ext=""
  [ "$os" = "windows" ] && ext=".exe"
  out="$OUT/vmq-agent-$os-$arch$ext"

  printf '  %-16s -> %s\n' "$target" "$out"
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" "$GO" build \
    -trimpath \
    -ldflags "-s -w -X main.Version=$VERSION" \
    -o "$out" ./cmd/vmq-agent
done

echo
echo "计算校验和…"
if command -v shasum >/dev/null 2>&1; then
  (cd "$OUT" && shasum -a 256 vmq-agent-* > SHA256SUMS)
elif command -v sha256sum >/dev/null 2>&1; then
  (cd "$OUT" && sha256sum vmq-agent-* > SHA256SUMS)
fi

echo "完成："
ls -lh "$OUT" | sed 's/^/  /'
