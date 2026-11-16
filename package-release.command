#!/usr/bin/env bash
#
# macOS double-clickable wrapper for scripts/package-release.sh.
#
# Finder 中双击即可打包（Terminal 会打开并显示结果）；也可以在终端里运行：
#   ./package-release.command [output-directory]

set -u

cd "$(dirname "$0")" || exit 1

bash ./scripts/package-release.sh "$@"
status=$?

echo
if [ "$status" -ne 0 ]; then
  echo "Release packaging failed."
else
  echo "Release packaging completed."
fi

# 双击运行时保留窗口，方便查看输出；非交互调用（CI/管道）不阻塞。
if [ -t 0 ]; then
  read -r -p "Press Enter to close..." _
fi

exit "$status"
