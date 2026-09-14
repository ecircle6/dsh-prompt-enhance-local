#!/bin/bash
# Build the host half (src/index.ts → lib/index.js).
#
# 两条路径：
#   ① 常规（CI / npm install 之后）：直接用本包 devDependencies 里的 tsc，
#      不碰 node_modules —— npm ci 装什么就编译什么。
#   ② 回退（本机无网络、或只想用 DSH 运行时自带的 TS）：探测 DSH checkout /
#      运行时安装目录，把 SDK 包软链进 node_modules 后再编译。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -x node_modules/.bin/tsc ]; then
  echo "=== Compiling host with local tsc (npm dependencies) ==="
  node_modules/.bin/tsc -p tsconfig.json
  echo "=== Host build complete ==="
  exit 0
fi

echo "=== No local tsc; falling back to a DSH runtime checkout ==="

CHECKOUT="${DSH_CHECKOUT:-}"
if [ -n "$CHECKOUT" ] && [ ! -d "$CHECKOUT/packages/core/tools" ]; then CHECKOUT=""; fi
if [ -z "$CHECKOUT" ]; then
  for candidate in "$HOME/dsh-harness" "$HOME/dsh" "$HOME/.dsh/dsh-harness"; do
    if [ -d "$candidate/packages/core/tools" ]; then CHECKOUT="$candidate"; break; fi
  done
fi

RUNTIME_NM=""
if [ -n "$CHECKOUT" ] && [ -d "$CHECKOUT/node_modules/@deepseek-ai/cordis" ]; then
  RUNTIME_NM="$CHECKOUT/node_modules"
else
  for candidate in /usr/lib/node_modules/@deepseek-ai/dsh/node_modules "$HOME/.dsh/profiles/node_modules"; do
    if [ -d "$candidate/@deepseek-ai/cordis" ]; then RUNTIME_NM="$candidate"; break; fi
  done
fi
if [ -z "$RUNTIME_NM" ]; then
  echo "build: no local tsc and no DSH runtime found — run \`npm install\` first" >&2
  exit 1
fi

TSC=""
if [ -n "$CHECKOUT" ] && [ -x "$CHECKOUT/node_modules/.bin/tsc" ]; then
  TSC="$CHECKOUT/node_modules/.bin/tsc"
else
  for candidate in "$HOME/dsh-compat-guard/node_modules/typescript/bin/tsc" "$HOME/dsh-upgrade-guard/node_modules/typescript/bin/tsc"; do
    if [ -f "$candidate" ]; then TSC="$candidate"; break; fi
  done
fi
if [ -z "$TSC" ]; then
  echo "build: no tsc available (set DSH_CHECKOUT or run npm install)" >&2
  exit 1
fi

link_pkg() {
  local dest="$1"
  local src="$2"
  if [ ! -e "$src" ]; then return 0; fi
  node -e "
    const fs = require('fs'), path = require('path');
    const link = path.resolve(process.argv[1]);
    const target = path.resolve(process.argv[2]);
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  " "node_modules/$dest" "$src"
}

echo "=== Linking build dependencies (runtime: $RUNTIME_NM) ==="
mkdir -p node_modules/@deepseek-ai node_modules/.bin
link_pkg cordis "$RUNTIME_NM/@deepseek-ai/cordis"
for p in cordis cosmokit schemastery standard-schema dsh-llm dsh-attachment dsh-typert-protocol dsh-tools dsh-system-prompt dsh-session dsh-settings dsh-host-webserver; do
  link_pkg "@deepseek-ai/$p" "$RUNTIME_NM/@deepseek-ai/$p"
done
link_pkg "@types/node" "${TYPES_NODE:-$RUNTIME_NM/@types/node}"
if [ ! -e node_modules/@types/node ] && [ -d "$HOME/.dsh/profiles/node_modules/@types/node" ]; then
  link_pkg "@types/node" "$HOME/.dsh/profiles/node_modules/@types/node"
fi

echo "=== Compiling host (src → lib) ==="
node "$TSC" -p tsconfig.json
echo "=== Host build complete ==="
