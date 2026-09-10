#!/bin/sh
# Vtuber's Monitor Link - POSIX launcher (ASCII only).
# Prefers a bundled runtime, then the system node on PATH.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
if [ -x "$HERE/runtime/node" ]; then
  NODE="$HERE/runtime/node"
else
  NODE="node"
fi
exec "$NODE" "$HERE/launch.cjs" "$@"
