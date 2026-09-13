// Capability text.normalize (docs/WORKERS.md section 2).
#pragma once

#include <string>

namespace vml {

// Applies steps 1-6 of section 2 to a UTF-8 string, in the order the contract
// gives them: delete, map, lowercase (table), fold (table), collapse, trim.
std::string NormalizeText(const std::string& text);

}  // namespace vml
