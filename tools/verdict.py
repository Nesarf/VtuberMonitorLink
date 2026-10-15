"""Report what a PE file's own signature says, in one word, for a build script to read.

Exists so that no build step has to compose a PowerShell command string. That is not tidiness: this
session produced four separate empty answers from inline `-Command` quoting and one confident wrong
conclusion from reading an empty answer as a verdict.

Three things had to be right, and each was found by getting it wrong first:

  * **A script file, not `-Command`.** A quoted path inside a quoted PowerShell expression came back
    empty, which then read as "this file carries something that does not verify".
  * **The file is written with a BOM** (`utf-8-sig`) because Windows PowerShell 5.1 reads a file without
    one as ANSI.
  * **The child gets a clean `PSModulePath`.** This was the real failure and it is the one worth
    remembering: with an inherited path, `Get-AuthenticodeSignature` reports "the command was found in
    the module 'Microsoft.PowerShell.Security', but the module could not be loaded" -- because PowerShell
    resolves modules by walking `PSModulePath` in order and taking the first directory that has the name,
    and a PowerShell 7 directory first makes Windows PowerShell load a binary module built for a different
    runtime. The command then does not exist. OnlySign's own `engine/ps.py` states this and is where the
    fix was taken from; the reasoning is copied here rather than re-derived.

    python tools/verdict.py <file>
    -> {"status": "...", "signer": "..."}  (exit 1 when there is no answer)
"""

from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys
import tempfile

STATUS_SCRIPT = """$ErrorActionPreference = 'Stop'
$s = Get-AuthenticodeSignature -LiteralPath {path}
$subject = ''
if ($s.SignerCertificate) {{ $subject = $s.SignerCertificate.Subject }}
[pscustomobject]@{{ status = $s.Status.ToString(); signer = $subject }} | ConvertTo-Json -Compress
"""


def ps_literal(value: str) -> str:
    """A PowerShell single-quoted string: backslashes are literal, the quote is doubled."""
    return "'" + str(value).replace("'", "''") + "'"


def find_powershell() -> tuple[str, dict[str, str]]:
    """(executable, environment) for a PowerShell that can load the Security module."""
    root = os.environ.get("SYSTEMROOT") or r"C:\Windows"
    executable = os.path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    if not os.path.isfile(executable):
        executable = "powershell.exe"

    env = dict(os.environ)
    # Windows PowerShell must be handed its own module directory and nothing else. See the module
    # docstring: this single line is the difference between a verdict and "the module could not be
    # loaded".
    if "WindowsPowerShell" in executable.replace("/", os.sep):
        modules = os.path.join(os.path.dirname(executable), "Modules")
        env["PSModulePath"] = modules
    return executable, env


def verdict(path: str) -> dict[str, str]:
    executable, env = find_powershell()
    with tempfile.TemporaryDirectory(prefix="vml-verdict-") as work:
        script = pathlib.Path(work) / "verdict.ps1"
        script.write_text(STATUS_SCRIPT.format(path=ps_literal(path)), encoding="utf-8-sig")
        done = subprocess.run(
            [executable, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script)],
            capture_output=True, text=True, errors="replace", env=env)
    out = (done.stdout or "").strip()
    if not out:
        detail = " ".join((done.stderr or "").split())[:300]
        return {"status": "", "signer": "", "error": detail or "empty stdout"}
    try:
        return json.loads(out)
    except ValueError:
        return {"status": out, "signer": ""}


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: python tools/verdict.py <file>", file=sys.stderr)
        return 2
    target = sys.argv[1]
    if not os.path.isfile(target):
        print(f"verdict: no such file: {target}", file=sys.stderr)
        return 1
    got = verdict(target)
    if not got.get("status"):
        print(f"verdict: no answer for {target}: {got.get('error') or 'empty stdout'}", file=sys.stderr)
        return 1
    print(json.dumps(got, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
