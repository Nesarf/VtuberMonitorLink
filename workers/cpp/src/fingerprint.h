// Capability text.fingerprint (docs/WORKERS.md section 4).
#pragma once

#include <string>

namespace vml {

struct FingerprintResult {
  std::string simhash;  // 16 lowercase hex characters, zero padded
  long long tokens = 0;
  long long shingles = 0;
};

FingerprintResult FingerprintText(const std::string& text);

}  // namespace vml
