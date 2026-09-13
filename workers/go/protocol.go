package main

// protocol.go implements docs/WORKERS.md section 1: JSON Lines over stdio, one JSON object per
// line, UTF-8, LF, no BOM. stdout carries protocol lines only; every diagnostic is English text on
// stderr.
//
// Output shape and key order are part of the contract ("field order in the JSON is the order the
// spec lists the fields in", and the corpus diffs bytes between languages). Every response is
// therefore built as an explicit byte sequence in a documented order, appended key by key:
//
//   describe  {"id":<id>,"ok":true,"worker":{"protocol":1,"capability":"...","language":"go",
//                                          "impl":"table-driven","runtime":"go1.x.y",
//                                          "deterministic":true}}
//   invoke ok {"id":<id>,"ok":true,"output":{...}}          (output order per capability, below)
//   error     {"id":<id>,"ok":false,"error":{"code":"bad-input","message":"..."}}
//   shutdown  {"id":<id>,"ok":true}
//
// The shapes are exactly the four in the contract's response block; no response carries a field the
// contract does not show for that response. (The JavaScript reference answers shutdown with an extra
// "output":{"bye":true}; the contract shows a bare ok for it, and the host is not diffed on the
// shutdown line, so this worker follows the contract. Reported, not silently chosen: see README.)
// Values that come from data (id, capability, runtime, message) go through encoding/json's string
// encoder so that escaping - control characters, quotes, non-ASCII - matches JSON.stringify byte for
// byte; the delimiters and key order are written here, not delegated to struct reflection. json.Marshal on a struct would emit a here-consistent order
// too, but only for as long as nobody reorders a struct field, so the order is pinned outright.
//
// Capability output orders (the order docs/WORKERS.md lists them in):
//   text.normalize    {"text":...}
//   text.extract      {"title":...,"text":...,"links":[{"href":...,"absolute":...,"text":...}],
//                      "images":N}
//   text.fingerprint  {"simhash":"...","tokens":N,"shingles":N}

import (
	"bytes"
	"encoding/json"
	"strconv"
)

const protocolVersion = 1

// jsonString returns v encoded as a JSON string with JSON.stringify-compatible escaping:
// HTML characters are NOT escaped (Go's default would turn "<" into "\u003c"), U+2028/U+2029 stay
// raw, and multi-byte characters stay raw UTF-8.
func jsonString(v string) []byte {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		// A string cannot fail to encode; fall back to a bare quoted literal rather than panicking.
		return []byte(`""`)
	}
	out := buf.Bytes()
	if n := len(out); n > 0 && out[n-1] == '\n' {
		out = out[:n-1]
	}
	return append([]byte(nil), out...)
}

func jsonInt(v int) []byte {
	return strconv.AppendInt(nil, int64(v), 10)
}

// appendKey writes ,"key": and returns the buffer, so key order is visible in the call site.
func appendKey(b []byte, key string, first bool) []byte {
	if !first {
		b = append(b, ',')
	}
	b = append(b, jsonString(key)...)
	return append(b, ':')
}

// appendField writes ,"key":<value> where value is already-encoded JSON.
func appendField(b []byte, key string, value []byte, first bool) []byte {
	b = appendKey(b, key, first)
	return append(b, value...)
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

func encodeDescribe(id []byte, capability, language, impl, runtimeVersion string) []byte {
	b := []byte{'{'}
	b = appendField(b, "id", id, true)
	b = appendField(b, "ok", []byte("true"), false)
	b = appendKey(b, "worker", false)
	b = append(b, '{')
	b = appendField(b, "protocol", jsonInt(protocolVersion), true)
	b = appendField(b, "capability", jsonString(capability), false)
	b = appendField(b, "language", jsonString(language), false)
	b = appendField(b, "impl", jsonString(impl), false)
	b = appendField(b, "runtime", jsonString(runtimeVersion), false)
	b = appendField(b, "deterministic", []byte("true"), false)
	b = append(b, '}', '}')
	return b
}

func encodeSuccessOutput(id []byte, output []byte) []byte {
	b := []byte{'{'}
	b = appendField(b, "id", id, true)
	b = appendField(b, "ok", []byte("true"), false)
	b = appendField(b, "output", output, false)
	return append(b, '}')
}

func encodeShutdownAck(id []byte) []byte {
	b := []byte{'{'}
	b = appendField(b, "id", id, true)
	b = appendField(b, "ok", []byte("true"), false)
	return append(b, '}')
}

func encodeError(id []byte, code, message string) []byte {
	b := []byte{'{'}
	b = appendField(b, "id", id, true)
	b = appendField(b, "ok", []byte("false"), false)
	b = appendKey(b, "error", false)
	b = append(b, '{')
	b = appendField(b, "code", jsonString(code), true)
	b = appendField(b, "message", jsonString(message), false)
	b = append(b, '}', '}')
	return b
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

func encodeNormalizeOutput(text string) []byte {
	b := []byte{'{'}
	b = appendField(b, "text", jsonString(text), true)
	return append(b, '}')
}

func encodeExtractOutput(out extractOutput) []byte {
	b := []byte{'{'}
	b = appendField(b, "title", jsonString(out.Title), true)
	b = appendField(b, "text", jsonString(out.Text), false)
	b = appendKey(b, "links", false)
	b = append(b, '[')
	for i, link := range out.Links {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, '{')
		b = appendField(b, "href", jsonString(link.Href), true)
		b = appendField(b, "absolute", boolBytes(link.Absolute), false)
		b = appendField(b, "text", jsonString(link.Text), false)
		b = append(b, '}')
	}
	b = append(b, ']')
	b = appendField(b, "images", jsonInt(out.Images), false)
	return append(b, '}')
}

func encodeFingerprintOutput(out fingerprintOutput) []byte {
	b := []byte{'{'}
	b = appendField(b, "simhash", jsonString(out.Simhash), true)
	b = appendField(b, "tokens", jsonInt(out.Tokens), false)
	b = appendField(b, "shingles", jsonInt(out.Shingles), false)
	return append(b, '}')
}

func boolBytes(v bool) []byte {
	if v {
		return []byte("true")
	}
	return []byte("false")
}

// rawID returns an already-encoded JSON value for the echoed id, or the literal null when the
// request did not carry one (a parse failure, for example: the id is unknown, and echoing the wrong
// id would be worse than echoing null).
func rawID(raw json.RawMessage) []byte {
	if len(raw) == 0 {
		return []byte("null")
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil {
		return []byte("null")
	}
	return compact.Bytes()
}
