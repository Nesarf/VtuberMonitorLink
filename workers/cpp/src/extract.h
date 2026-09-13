// Capability text.extract (docs/WORKERS.md section 3).
#pragma once

#include <string>
#include <vector>

namespace vml {

struct ExtractLink {
  std::string href;
  bool absolute = false;
  std::string text;
};

struct ExtractResult {
  std::string title;
  std::string text;
  std::vector<ExtractLink> links;
  int images = 0;
};

ExtractResult ExtractHtml(const std::string& html);

}  // namespace vml
