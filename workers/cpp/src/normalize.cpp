#include "normalize.h"

#include <cstdint>
#include <string>

#include "tables.h"
#include "utf8.h"

namespace vml {
namespace {

// Section 2 step 1: delete these code points outright.
bool IsDeleted(uint32_t cp) {
  if (cp <= 0x0008u) return true;                       // U+0000-U+0008
  if (cp == 0x000Bu || cp == 0x000Cu) return true;      // U+000B, U+000C
  if (cp >= 0x000Eu && cp <= 0x001Fu) return true;      // U+000E-U+001F
  if (cp == 0x007Fu) return true;                       // U+007F
  if (cp >= 0x0300u && cp <= 0x036Fu) return true;      // combining marks
  if (cp >= 0x1AB0u && cp <= 0x1AFFu) return true;      // combining marks extended
  if (cp >= 0x1DC0u && cp <= 0x1DFFu) return true;      // combining marks supplement
  if (cp >= 0x200Bu && cp <= 0x200Fu) return true;      // U+200B-U+200F
  if (cp >= 0x202Au && cp <= 0x202Eu) return true;      // U+202A-U+202E
  if (cp >= 0x2060u && cp <= 0x2064u) return true;      // U+2060-U+2064
  if (cp >= 0x20D0u && cp <= 0x20FFu) return true;      // combining marks for symbols
  if (cp >= 0xFE20u && cp <= 0xFE2Fu) return true;      // combining half marks
  if (cp == 0xFEFFu) return true;                       // U+FEFF
  return false;
}

// Section 2 step 2: one-to-one mapping to a single code point.
// Returns true and sets *out when the code point is mapped.
bool MapCodePoint(uint32_t cp, uint32_t* out) {
  if (cp == 0x00A0u || (cp >= 0x2000u && cp <= 0x200Au) || cp == 0x2028u ||
      cp == 0x2029u || cp == 0x202Fu || cp == 0x205Fu || cp == 0x3000u) {
    *out = 0x0020u;
    return true;
  }
  if (cp >= 0xFF01u && cp <= 0xFF5Eu) {
    *out = cp - 0xFEE0u;  // full-width ASCII -> ASCII
    return true;
  }
  switch (cp) {
    case 0x2018u:
    case 0x2019u:
    case 0x201Bu:
    case 0x2032u:
      *out = 0x0027u;
      return true;
    case 0x201Cu:
    case 0x201Du:
    case 0x201Fu:
    case 0x2033u:
      *out = 0x0022u;
      return true;
    case 0x2010u:
    case 0x2011u:
    case 0x2012u:
    case 0x2013u:
    case 0x2014u:
    case 0x2015u:
    case 0x2212u:
      *out = 0x002Du;
      return true;
    case 0x3001u:
      *out = 0x002Cu;
      return true;
    case 0x3002u:
      *out = 0x002Eu;
      return true;
    default:
      return false;
  }
}

bool IsCollapsibleSpace(uint32_t cp) {
  return cp == 0x0020u || cp == 0x0009u || cp == 0x000Au || cp == 0x000Du;
}

}  // namespace

std::string NormalizeText(const std::string& text) {
  // Steps 1-4, all of which are per-code-point, in a single walk over the UTF-8
  // bytes. Decoding here is required: the rules are defined per code point.
  std::string stage;
  stage.reserve(text.size());
  size_t i = 0;
  while (i < text.size()) {
    uint32_t cp = Utf8Next(text, i);
    if (IsDeleted(cp)) continue;  // step 1
    if (cp == 0x2026u) {          // step 2: the one rule mapping one code point to three
      stage += "...";
      continue;
    }
    uint32_t mapped = 0;
    if (MapCodePoint(cp, &mapped)) cp = mapped;  // step 2
    uint32_t lowered = 0;
    if (LowerLookup(cp, &lowered)) cp = lowered;  // step 3, table only
    size_t foldLength = 0;
    const char* folded = FoldLookup(cp, &foldLength);  // step 4, table only
    if (folded != nullptr) {
      stage.append(folded, foldLength);
    } else {
      Utf8Append(stage, cp);
    }
  }

  // Steps 5 and 6: collapse runs of space/tab/LF/CR into one space, then trim.
  std::string out;
  out.reserve(stage.size());
  bool inSpaceRun = false;
  size_t j = 0;
  while (j < stage.size()) {
    const uint32_t cp = Utf8Next(stage, j);
    if (IsCollapsibleSpace(cp)) {
      if (!inSpaceRun) {
        out.push_back(' ');
        inSpaceRun = true;
      }
      continue;
    }
    inSpaceRun = false;
    Utf8Append(out, cp);
  }
  size_t begin = 0;
  size_t end = out.size();
  while (begin < end && out[begin] == ' ') ++begin;
  while (end > begin && out[end - 1] == ' ') --end;
  return out.substr(begin, end - begin);
}

}  // namespace vml
