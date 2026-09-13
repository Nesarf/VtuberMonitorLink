// --selfcheck: the built-in case list required by docs/WORKERS.md section 1.1.
#pragma once

namespace vml {

// Runs the built-in cases, prints one English line per case plus a
// "N/M checks passed" summary on stderr, and returns the process exit code
// (0 when every case passed, 1 otherwise). Nothing is written to stdout.
int RunSelfcheck();

}  // namespace vml
