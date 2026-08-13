#!/usr/bin/env bash

# 遇到错误立即退出，未定义变量报错
set -euo pipefail

# --- 1. 配置默认参数与生产环境变量 ---
SUBDOMAIN=""  # 默认为空
REPO_URL="https://github.com/yabby-groups/infinite-canvas.git"
PROJECT_DIR="infinite-canvas"
TARGET_DIR="infinite-canvas/canvas-agent"

# 切换为生产环境模式
export NODE_ENV=production

# --- 2. 解析命令行参数 ---
while [[ $# -gt 0 ]]; do
  case $1 in
    --subdomain)
      SUBDOMAIN="$2"
      shift 2
      ;;
    *)
      echo "⚠️ 未知参数: $1"
      shift
      ;;
  esac
done

echo "🏭 [Production] 开始配置并启动 canvas-agent..."
if [ -n "$SUBDOMAIN" ]; then
  echo "🌐 Subdomain 设置为: $SUBDOMAIN"
else
  echo "🌐 Subdomain 默认为空"
fi

# --- 3. 检查基础环境 ---
for cmd in git node npm; do
  if ! command -v $cmd &> /dev/null; then
    echo "❌ 错误: 未找到 $cmd 命令，请先安装 $cmd。"
    exit 1
  fi
done

# --- 4. 克隆或拉取最新代码，并判断是否有更新 ---
NEED_BUILD=false

if [ ! -d "$PROJECT_DIR" ]; then
  echo "📥 正在克隆 GitHub 仓库..."
  git clone "$REPO_URL"
  NEED_BUILD=true
else
  echo "🔄 仓库已存在，清理本地修改并拉取最新代码..."
  cd "$PROJECT_DIR"
  git checkout .
  git clean -fd

  # 捕获 git pull 输出
  PULL_OUTPUT=$(git pull)
  echo "$PULL_OUTPUT"
  cd ..

  # 判断是否有新代码拉取或缺少 dist/index.js 产物
  if [[ "$PULL_OUTPUT" != *"Already up to date."* ]] || [ ! -f "$TARGET_DIR/dist/index.js" ]; then
    NEED_BUILD=true
  fi
fi

# --- 5. 进入目标目录 ---
if [ -d "$TARGET_DIR" ]; then
  cd "$TARGET_DIR"
else
  echo "❌ 错误: 未找到目录 $TARGET_DIR"
  exit 1
fi

# --- 6. 根据 NEED_BUILD 状态决定是否重新安装依赖和构建 ---
if [ "$NEED_BUILD" = true ]; then
  echo "📦 检测到代码更新或缺少构建产物，开始安装依赖..."
  if [ -f "package-lock.json" ]; then
    npm ci --include=dev
  else
    npm install --include=dev
  fi

  echo "🛠️ 正在构建项目 (npm run build)..."
  npm run build
else
  echo "⚡ 代码已是最新，跳过依赖安装与构建步骤。"
fi

# --- 7. 检查产物并直接用 Node 运行 dist/index.js ---
if [ ! -f "dist/index.js" ]; then
  echo "❌ 错误: 未找到 dist/index.js 文件，请检查构建是否成功。"
  exit 1
fi

export SUBDOMAIN="$SUBDOMAIN"

EXTRA_ARGS=""
if [ -n "$SUBDOMAIN" ]; then
  EXTRA_ARGS="--subdomain $SUBDOMAIN"
fi

echo "🚀 执行: node dist/index.js $EXTRA_ARGS"
exec node dist/index.js $EXTRA_ARGS
