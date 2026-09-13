package main

// jsonwire.go - the protocol implementation for this artifact.
//
// The text worker's protocol lives in the root package (workers/go/protocol.go), which this package
// is not compiled with, so it implements its own. It is deliberately a copy of that file's helpers:
// the text worker was left untouched, and the Go standard library cannot share them across two
// binaries without an internal package.
//
// The protocol is docs/WORKERS.md section 1: JSON Lines over stdio, one JSON object per line, UTF-8,
// LF, no BOM. stdout carries protocol lines only; every diagnostic is English text on stderr.
//
// Field order is part of the contract - the corpus diffs answers across languages - and a Go map
// would emit its keys in a random order, so every response and every output object is built as an
// explicit byte sequence, key by key, in the order docs/WORKERS.md lists it:
//
//	describe  {"id":<id>,"ok":true,"worker":{"protocol":1,"capability":"...","language":"go",
//	                                          "impl":"...","runtime":"go1.x.y","deterministic":true}}
//	invoke ok {"id":<id>,"ok":true,"output":{...}}
//	error     {"id":<id>,"ok":false,"error":{"code":"bad-input","message":"..."}}
//	shutdown  {"id":<id>,"ok":true}
//
// The fetch.plan output order (docs/WORKERS.md section 10) is
//
//	{"batches":[{"egress":...,"sources":[...]}],"deferred":[{"id":...,"reason":...}],
//	 "skipped":[{"id":...,"reason":...}],"counts":{"planned":N,"deferred":N,"skipped":N}}
//
// Values that come from data (id, capability, runtime, message, source ids, egress names) go through
// encoding/json's string encoder with SetEscapeHTML(false), so escaping matches JSON.stringify byte
// for byte: raw "<", ">", "&", raw U+2028/U+2029, raw UTF-8. The delimiters and the key order are
// written here, not delegated to struct reflection or to a map.

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strconv"
)

const protocolVersion = 1

// jsonString returns v encoded as a JSON string with JSON.stringify-compatible escaping.
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

// appendKey writes ,"key": and returns the buffer, so the key order is visible at the call site.
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

// rawID returns an already-encoded JSON value for the echoed id, or the literal null when the request
// carried none (a parse failure, for example): echoing the wrong id would be worse than echoing null.
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

// ---------------------------------------------------------------------------
// The fetch.plan output
// ---------------------------------------------------------------------------

func encodePlanOutput(out planOutput) []byte {
	b := []byte{'{'}
	b = appendKey(b, "batches", true)
	b = append(b, '[')
	for i, batch := range out.Batches {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, '{')
		b = appendField(b, "egress", jsonString(batch.Egress), true)
		b = appendKey(b, "sources", false)
		b = append(b, '[')
		for j, id := range batch.Sources {
			if j > 0 {
				b = append(b, ',')
			}
			b = append(b, jsonString(id)...)
		}
		b = append(b, ']')
		b = append(b, '}')
	}
	b = append(b, ']')

	b = appendField(b, "deferred", jsonReasonList(out.Deferred), false)
	b = appendField(b, "skipped", jsonReasonList(out.Skipped), false)

	b = appendKey(b, "counts", false)
	b = append(b, '{')
	b = appendField(b, "planned", jsonInt(out.Counts.Planned), true)
	b = appendField(b, "deferred", jsonInt(out.Counts.Deferred), false)
	b = appendField(b, "skipped", jsonInt(out.Counts.Skipped), false)
	b = append(b, '}', '}')
	return b
}

func jsonReasonList(rows []reasonRow) []byte {
	b := []byte{'['}
	for i, row := range rows {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, '{')
		b = appendField(b, "id", jsonString(row.ID), true)
		b = appendField(b, "reason", jsonString(row.Reason), false)
		b = append(b, '}')
	}
	return append(b, ']')
}

// ---------------------------------------------------------------------------
// Reading the request input
// ---------------------------------------------------------------------------

// decodeValue parses one JSON value. Numbers are kept as json.Number so that a big timestamp is
// compared exactly instead of going through a float64: `now` is epoch milliseconds, and a
// scheduler that rounds its timestamps is a scheduler that disagrees with every other language.
func decodeValue(data []byte) (interface{}, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var value interface{}
	if err := dec.Decode(&value); err != nil {
		return nil, err
	}
	// The caller passes one already-split protocol line, so trailing bytes can only be garbage.
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("trailing data after the JSON value")
	}
	return value, nil
}

// objectValue unwraps a JSON object into a lookup function over its members. A value that is not an
// object is reported as such, because the contract validates the shape of the input before it
// validates any of its members; how a member of the wrong shape is then treated is the caller's job.
func objectValue(value interface{}) (func(key string) (interface{}, bool), error) {
	object, ok := value.(map[string]interface{})
	if !ok {
		return nil, errors.New("value is not a JSON object")
	}
	return func(key string) (interface{}, bool) {
		member, present := object[key]
		return member, present
	}, nil
}

// explicitlyDue reports whether a source object carries `due: true`. The contract makes `due` an
// optional flag whose only meaningful value is the boolean true ("`due` is how the application asks
// for a manual refresh"); a missing `due`, or `due: false`, leaves the decision to the clock. That is
// a different question from "is the value truthy", which is why it is asked as a type assertion here
// and not as a `!= 0` test anywhere.
func explicitlyDue(object map[string]interface{}) bool {
	value, present := object["due"]
	if !present {
		return false
	}
	due, isBool := value.(bool)
	return isBool && due
}
