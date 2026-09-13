// Access to the shared spec tables (workers/spec/latin-lower.json and
// workers/spec/latin-fold.json), embedded at build time by workers/cpp/build.mjs.
//
// docs/WORKERS.md section 2 is explicit: "The case and fold tables are shared
// data, not per-language library behaviour ... nobody consults their own
// runtime's tables." C++ has no Unicode case tables at all, which makes the
// table-driven design the only possible one here - and the correct one.
#pragma once

#include <cstddef>
#include <cstdint>

namespace vml {

// latin-lower.json: code point -> lowercase code point, one to one, U+0000-U+024F.
bool LowerLookup(uint32_t codePoint, uint32_t* replacement);

// latin-fold.json: code point -> ASCII replacement string (1-2 characters).
// Returns nullptr when the code point has no entry.
const char* FoldLookup(uint32_t codePoint, size_t* length);

uint32_t LowerTableSize();
uint32_t FoldTableSize();

// Compiler identity recorded by build.mjs, reported in the describe response.
const char* CompilerId();

}  // namespace vml
