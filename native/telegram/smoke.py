#!/usr/bin/env python3
"""Offline ABI smoke check for the actual official TDLib shared library."""
import json
import os
from pathlib import Path
import subprocess
import time

root = Path(__file__).resolve().parents[2]
bridge = os.environ.get("TELEGRAM_TDLIB_BRIDGE_PATH", str(root / "native/telegram/build/tdjson-bridge"))
library = os.environ.get("TELEGRAM_TDJSON_LIBRARY", str(root / ".local/tdlib/lib/libtdjson.so"))
process = subprocess.Popen([bridge, library], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
for key, request in enumerate([
    {"@type": "getOption", "name": "version"},
    {"@type": "getOption", "name": "commit_hash"},
    {"@type": "getAuthorizationState"},
]):
    process.stdin.write((json.dumps({**request, "@extra": str(key)}) + "\n").encode())
process.stdin.flush()
time.sleep(2)
try:
    output, diagnostics = process.communicate(input=b'{"@type":"close"}\n', timeout=10)
except subprocess.TimeoutExpired:
    process.kill()
    process.communicate()
    raise SystemExit("TDLIB_SMOKE_TIMEOUT") from None
items = [json.loads(line) for line in output.decode().splitlines()]
result = {
    "version": next((i.get("value") for i in items if i.get("@extra") == "0"), None),
    "reportedCommit": next((i.get("value") for i in items if i.get("@extra") == "1"), None),
    "authorizationState": next((i.get("@type") for i in items if i.get("@extra") == "2"), None),
    "exitCode": process.returncode,
    "liveAccountAuthorization": False,
}
print(json.dumps(result, indent=2))
if not result["version"] or result["authorizationState"] != "authorizationStateWaitTdlibParameters" or process.returncode != 0:
    raise SystemExit("TDLIB_SMOKE_FAILED")
