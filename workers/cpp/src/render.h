// Builds the `output` object of each capability, with the field order the
// contract lists them in (docs/WORKERS.md sections 2, 3, 4). Used by both the
// protocol loop and --selfcheck so that the two can never drift apart.
#pragma once

#include <string>

#include "json.h"

namespace vml {

JsonValue RenderNormalize(const std::string& text);
JsonValue RenderExtract(const std::string& html);
JsonValue RenderFingerprint(const std::string& text);

// The bare shutdown acknowledgment {"id":N,"ok":true} from section 1. Shared
// with the protocol loop so --selfcheck can pin its shape.
JsonValue RenderShutdownAck(const JsonValue& id);

}  // namespace vml
