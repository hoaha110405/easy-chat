#!/usr/bin/env bash
set -euo pipefail
task_root=$(cd "$(dirname "$0")/../.." && pwd)
td_revision=4c6377aa7386c39217878a9a56d581922ad37ca4
td_archive_sha256=472015605fffa826bfba6ccf7d888905b436ecce94c8a6826203792edfbe5731
td_cache="$task_root/.cache/tdlib"
td_prefix="${TDLIB_INSTALL_PREFIX:-$task_root/.local/tdlib}"
mkdir -p "$td_cache"
if ! command -v cmake >/dev/null || ! command -v c++ >/dev/null; then
  echo 'Install CMake and a C++17 compiler before building TDLib.' >&2; exit 1
fi
td_gperf="${GPERF_EXECUTABLE:-$(command -v gperf || true)}"
if [ -z "$td_gperf" ] && [ -x "$task_root/.local/tdlib-tools/bin/gperf" ]; then td_gperf="$task_root/.local/tdlib-tools/bin/gperf"; fi
if [ -z "$td_gperf" ]; then echo 'Install gperf or set GPERF_EXECUTABLE to its path.' >&2; exit 1; fi
td_archive="$td_cache/tdlib-$td_revision.tar.gz"
if [ ! -f "$td_archive" ]; then curl --fail --location --proto '=https' --tlsv1.2 "https://codeload.github.com/tdlib/td/tar.gz/$td_revision" -o "$td_archive"; fi
printf '%s  %s\n' "$td_archive_sha256" "$td_archive" | sha256sum --check --status
if [ ! -d "$td_cache/td-$td_revision" ]; then tar -xzf "$td_archive" -C "$td_cache"; fi
cmake -S "$td_cache/td-$td_revision" -B "$td_cache/build" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_FLAGS_RELEASE='-O1 -DNDEBUG' \
  -DCMAKE_INSTALL_PREFIX="$td_prefix" -DTD_INSTALL_STATIC_LIBRARIES=OFF \
  -DTD_ENABLE_LTO=OFF -DGPERF_EXECUTABLE="$td_gperf"
cmake --build "$td_cache/build" --target tdjson -j "${TDLIB_BUILD_JOBS:-1}"
cmake --install "$td_cache/build" --prefix "$td_prefix"
mkdir -p "$td_prefix/share/licenses/tdlib"
cp "$td_cache/td-$td_revision/LICENSE_1_0.txt" "$td_prefix/share/licenses/tdlib/"
printf '%s\n' "$td_revision" > "$td_prefix/share/licenses/tdlib/SOURCE_REVISION"
cmake -S "$task_root/native/telegram" -B "$task_root/native/telegram/build" -DCMAKE_BUILD_TYPE=Release
cmake --build "$task_root/native/telegram/build" -j1
printf 'Official TDLib revision %s installed in %s\n' "$td_revision" "$td_prefix"
