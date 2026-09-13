#include "tables.h"

#include "tables.generated.h"

namespace vml {

bool LowerLookup(uint32_t codePoint, uint32_t* replacement) {
  const uint32_t* from = generated::kLowerFrom;
  // The generated arrays are sorted by code point, so a binary search keeps the
  // hot path O(log n) without any hash container (whose iteration order would
  // not be deterministic, and which is not needed here anyway).
  size_t lo = 0;
  size_t hi = generated::kLowerCount;
  while (lo < hi) {
    const size_t mid = lo + (hi - lo) / 2;
    if (from[mid] == codePoint) {
      *replacement = generated::kLowerTo[mid];
      return true;
    }
    if (from[mid] < codePoint) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return false;
}

const char* FoldLookup(uint32_t codePoint, size_t* length) {
  const uint32_t* from = generated::kFoldFrom;
  size_t lo = 0;
  size_t hi = generated::kFoldCount;
  while (lo < hi) {
    const size_t mid = lo + (hi - lo) / 2;
    if (from[mid] == codePoint) {
      const char* value = generated::kFoldTo[mid];
      size_t n = 0;
      while (value[n] != '\0') ++n;
      *length = n;
      return value;
    }
    if (from[mid] < codePoint) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return nullptr;
}

uint32_t LowerTableSize() { return generated::kLowerCount; }

uint32_t FoldTableSize() { return generated::kFoldCount; }

const char* CompilerId() { return generated::kCompilerId; }

}  // namespace vml
