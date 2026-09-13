// Protocol byte I/O: the two pieces that make the worker answer a host that
// keeps stdin open for the whole run.
//
// This exists as its own translation unit because both halves are testable and
// both have bitten a worker in this repository:
//
//   * stdin must be read **unbuffered**. A host writes a request line and then
//     waits for the answer; it closes the pipe only after `shutdown`. A buffered
//     fread on a pipe keeps asking the kernel for more bytes until it has filled
//     its buffer, so a worker that reads a block at a time answers nothing at
//     all while the host times out. Verified by a selfcheck case that runs the
//     LineReader over a pipe whose write end stays open.
//
//   * stdout must be flushed after every response line, or the answer sits in
//     the C library's buffer until the process exits - which for a host that is
//     waiting for that very line means a timeout. Also verified by a selfcheck
//     case.
#pragma once

#include <cstdio>
#include <string>

namespace vml {

// docs/WORKERS.md section 1.2, the C/C++ entry: bytes on stdin/stdout/stderr in
// binary mode, never the wide-character console APIs.
void ConfigureStdio();

// Writes one line (LF terminated) and flushes it.
void WriteLine(std::FILE* stream, const std::string& line);

// Reads complete lines, returning each one as soon as it has arrived rather than
// waiting for the stream to end or for a buffer to fill.
class LineReader {
 public:
  explicit LineReader(std::FILE* stream);

  // Returns false once the stream is exhausted (EOF), after returning any final
  // line that arrived without a terminating newline.
  bool Next(std::string* line);

 private:
  std::FILE* stream_;
  char buffer_[4096];
  size_t length_ = 0;
  size_t position_ = 0;
};

}  // namespace vml
