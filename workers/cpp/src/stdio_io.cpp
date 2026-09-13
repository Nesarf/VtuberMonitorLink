#include "stdio_io.h"

#include <cstring>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#else
#include <unistd.h>
#endif

namespace vml {

void ConfigureStdio() {
#ifdef _WIN32
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
  _setmode(_fileno(stderr), _O_BINARY);
#endif
  std::setvbuf(stdin, nullptr, _IONBF, 0);
}

void WriteLine(std::FILE* stream, const std::string& line) {
  if (!line.empty()) std::fwrite(line.data(), 1, line.size(), stream);
  std::fputc('\n', stream);
  std::fflush(stream);
}

namespace {

// One byte-level read. Reads through the file descriptor rather than fread so
// that a short read is returned immediately instead of being retried until the
// buffer is full - see the note in stdio_io.h. Nothing else in this program
// touches stdin's stdio buffer, so the two cannot disagree.
int ReadSome(std::FILE* stream, char* buffer, size_t capacity) {
#ifdef _WIN32
  return _read(_fileno(stream), buffer, static_cast<unsigned int>(capacity));
#else
  const ssize_t got = ::read(fileno(stream), buffer, capacity);
  return got < 0 ? -1 : static_cast<int>(got);
#endif
}

}  // namespace

LineReader::LineReader(std::FILE* stream) : stream_(stream) {}

bool LineReader::Next(std::string* line) {
  line->clear();
  bool sawData = false;
  for (;;) {
    if (position_ >= length_) {
      const int got = ReadSome(stream_, buffer_, sizeof(buffer_));
      if (got <= 0) return sawData;
      length_ = static_cast<size_t>(got);
      position_ = 0;
    }
    const char* const start = buffer_ + position_;
    const size_t available = length_ - position_;
    const char* const newline = static_cast<const char*>(std::memchr(start, '\n', available));
    if (newline != nullptr) {
      line->append(start, static_cast<size_t>(newline - start));
      position_ = static_cast<size_t>(newline - buffer_) + 1;
      return true;
    }
    line->append(start, available);
    position_ = length_;
    sawData = true;
  }
}

}  // namespace vml
