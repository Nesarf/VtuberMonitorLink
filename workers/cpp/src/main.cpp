// vmltext - the C++17 worker for the three text capabilities of docs/WORKERS.md.
//
// Protocol v1 (section 1): JSON Lines over stdio, one request object per line,
// one response object per line. stdout carries protocol lines and nothing else;
// stderr carries English diagnostics. Section 1.2 is the reason this file works
// in bytes only: stdin/stdout are switched to binary mode and everything is
// read and written with fread/fwrite. There is no wide-character console API
// anywhere in this program.
//
// Every response is built as a JsonValue and serialized with an insertion-ordered
// member list, so the output bytes are deterministic: no unordered container
// ever reaches the output.
#include <cstdio>
#include <cstring>
#include <string>
#include <utility>

#include "json.h"
#include "render.h"
#include "selfcheck.h"
#include "stdio_io.h"
#include "tables.h"

namespace {

const char* const kCapabilityNormalize = "text.normalize";
const char* const kCapabilityExtract = "text.extract";
const char* const kCapabilityFingerprint = "text.fingerprint";
constexpr long long kProtocolVersion = 1;

std::string Usage() {
  return "usage: vmltext.exe --capability <text.normalize|text.extract|text.fingerprint> "
         "[--selfcheck]\n";
}

bool IsKnownCapability(const std::string& capability) {
  return capability == kCapabilityNormalize || capability == kCapabilityExtract ||
         capability == kCapabilityFingerprint;
}

vml::JsonValue WorkerDescriptor(const std::string& capability) {
  vml::JsonValue worker = vml::JsonObject();
  worker.members.emplace_back("protocol", vml::JsonInt(kProtocolVersion));
  worker.members.emplace_back("capability", vml::JsonString(capability));
  worker.members.emplace_back("language", vml::JsonString("cpp"));
  worker.members.emplace_back("impl", vml::JsonString("table-driven"));
  worker.members.emplace_back("runtime", vml::JsonString(vml::CompilerId()));
  worker.members.emplace_back("deterministic", vml::JsonBool(true));
  return worker;
}

vml::JsonValue ErrorEnvelope(const std::string& code, const std::string& message) {
  vml::JsonValue error = vml::JsonObject();
  error.members.emplace_back("code", vml::JsonString(code));
  error.members.emplace_back("message", vml::JsonString(message));
  return error;
}

}  // namespace

int main(int argc, char** argv) {
  vml::ConfigureStdio();

  std::string capability;
  bool capabilityGiven = false;
  bool selfcheck = false;

  for (int i = 1; i < argc; ++i) {
    const std::string argument = argv[i];
    if (argument == "--selfcheck") {
      selfcheck = true;
    } else if (argument == "--capability") {
      if (i + 1 >= argc) {
        vml::WriteLine(stderr, "vmltext: --capability requires a value");
        std::fwrite(Usage().data(), 1, Usage().size(), stderr);
        return 2;
      }
      capability = argv[++i];
      capabilityGiven = true;
    } else if (argument.compare(0, 13, "--capability=") == 0) {
      capability = argument.substr(13);
      capabilityGiven = true;
    } else {
      vml::WriteLine(stderr, "vmltext: unexpected argument: " + argument);
      std::fwrite(Usage().data(), 1, Usage().size(), stderr);
      std::fflush(stderr);
      return 2;
    }
  }

  if (selfcheck) return vml::RunSelfcheck();

  if (!capabilityGiven) {
    vml::WriteLine(stderr, "vmltext: --capability <name> is required");
    std::fwrite(Usage().data(), 1, Usage().size(), stderr);
    std::fflush(stderr);
    return 2;
  }
  if (!IsKnownCapability(capability)) {
    vml::WriteLine(stderr, "vmltext: unknown capability: " + capability);
    std::fwrite(Usage().data(), 1, Usage().size(), stderr);
    std::fflush(stderr);
    return 2;
  }

  vml::LineReader reader(stdin);
  std::string line;
  while (reader.Next(&line)) {
    // A host that writes text mode on Windows would send CRLF; tolerate it.
    if (!line.empty() && line[line.size() - 1] == '\r') line.erase(line.size() - 1);
    bool blank = true;
    for (size_t i = 0; i < line.size(); ++i) {
      const char c = line[i];
      if (c != ' ' && c != '\t' && c != '\r') {
        blank = false;
        break;
      }
    }
    if (blank) continue;

    vml::JsonValue request;
    std::string parseError;
    if (!vml::JsonParse(line, request, parseError)) {
      vml::JsonValue response = vml::JsonObject();
      response.members.emplace_back("id", vml::JsonNull());
      response.members.emplace_back("ok", vml::JsonBool(false));
      response.members.emplace_back(
          "error", ErrorEnvelope("bad-input", "request is not JSON: " + parseError));
      vml::WriteLine(stdout, vml::JsonSerialize(response));
      continue;
    }

    const vml::JsonValue* const idValue = request.Find("id");
    const vml::JsonValue id = idValue != nullptr ? *idValue : vml::JsonNull();

    if (!request.IsObject()) {
      vml::JsonValue response = vml::JsonObject();
      response.members.emplace_back("id", id);
      response.members.emplace_back("ok", vml::JsonBool(false));
      response.members.emplace_back("error",
                                    ErrorEnvelope("bad-input", "request must be a JSON object"));
      vml::WriteLine(stdout, vml::JsonSerialize(response));
      continue;
    }

    const vml::JsonValue* const opValue = request.Find("op");
    if (opValue == nullptr || !opValue->IsString()) {
      vml::JsonValue response = vml::JsonObject();
      response.members.emplace_back("id", id);
      response.members.emplace_back("ok", vml::JsonBool(false));
      response.members.emplace_back("error",
                                    ErrorEnvelope("bad-input", "request.op must be a string"));
      vml::WriteLine(stdout, vml::JsonSerialize(response));
      continue;
    }
    const std::string& op = opValue->str;

    if (op == "describe") {
      vml::JsonValue response = vml::JsonObject();
      response.members.emplace_back("id", id);
      response.members.emplace_back("ok", vml::JsonBool(true));
      response.members.emplace_back("worker", WorkerDescriptor(capability));
      vml::WriteLine(stdout, vml::JsonSerialize(response));
      continue;
    }

    if (op == "shutdown") {
      // Section 1: the bare envelope, nothing else. Nothing on the host side
      // diffs a shutdown line, but the shape is pinned so that every
      // implementation answers it identically.
      vml::WriteLine(stdout, vml::JsonSerialize(vml::RenderShutdownAck(id)));
      return 0;
    }

    if (op != "invoke") {
      vml::JsonValue response = vml::JsonObject();
      response.members.emplace_back("id", id);
      response.members.emplace_back("ok", vml::JsonBool(false));
      response.members.emplace_back("error", ErrorEnvelope("unsupported", "unknown op: " + op));
      vml::WriteLine(stdout, vml::JsonSerialize(response));
      continue;
    }

    const vml::JsonValue* const requestedCapability = request.Find("capability");
    if (requestedCapability == nullptr || !requestedCapability->IsString()) {
      vml::JsonValue response = vml::JsonObject();
      response.members.emplace_back("id", id);
      response.members.emplace_back("ok", vml::JsonBool(false));
      response.members.emplace_back(
          "error", ErrorEnvelope("bad-input", "request.capability must be a string"));
      vml::WriteLine(stdout, vml::JsonSerialize(response));
      continue;
    }
    if (requestedCapability->str != capability) {
      // One worker process handles one capability (section 1), so a request for
      // another one is refused work rather than answered with the wrong rules.
      vml::JsonValue response = vml::JsonObject();
      response.members.emplace_back("id", id);
      response.members.emplace_back("ok", vml::JsonBool(false));
      response.members.emplace_back(
          "error",
          ErrorEnvelope("unsupported", "capability \"" + requestedCapability->str +
                                           "\" is not implemented by this worker (" + capability +
                                           ")"));
      vml::WriteLine(stdout, vml::JsonSerialize(response));
      continue;
    }

    const vml::JsonValue* const inputValue = request.Find("input");
    const vml::JsonValue emptyInput = vml::JsonObject();
    const vml::JsonValue& input =
        (inputValue != nullptr && inputValue->IsObject()) ? *inputValue : emptyInput;

    const char* textKey = (capability == kCapabilityExtract) ? "html" : "text";
    const vml::JsonValue* const sourceValue = input.Find(textKey);
    if (sourceValue == nullptr || !sourceValue->IsString()) {
      vml::JsonValue response = vml::JsonObject();
      response.members.emplace_back("id", id);
      response.members.emplace_back("ok", vml::JsonBool(false));
      response.members.emplace_back(
          "error", ErrorEnvelope("bad-input",
                                 std::string("input.") + textKey + " must be a string"));
      vml::WriteLine(stdout, vml::JsonSerialize(response));
      continue;
    }

    vml::JsonValue output;
    if (capability == kCapabilityNormalize) {
      output = vml::RenderNormalize(sourceValue->str);
    } else if (capability == kCapabilityExtract) {
      output = vml::RenderExtract(sourceValue->str);
    } else {
      output = vml::RenderFingerprint(sourceValue->str);
    }

    vml::JsonValue response = vml::JsonObject();
    response.members.emplace_back("id", id);
    response.members.emplace_back("ok", vml::JsonBool(true));
    response.members.emplace_back("output", std::move(output));
    vml::WriteLine(stdout, vml::JsonSerialize(response));
  }

  return 0;
}
