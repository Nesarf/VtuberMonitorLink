package main

// main.go - the command line and the stdio request loop of docs/WORKERS.md section 1.1, for the Go
// implementation of `fetch.plan`.
//
//	vmlfetch --capability fetch.plan   run the protocol loop
//	vmlfetch --selfcheck               run the built-in case list and print one English line per case
//	anything else                      an English error on stderr, exit 2
//
// stdout carries protocol lines and nothing else, ever; stdout is flushed after every response
// (os.Stdout is unbuffered in Go, so "flushing" is the absence of a buffer - the trap in the contract
// section 1 belongs to the C and C++ workers). Every diagnostic is English text on stderr.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"runtime"
)

const (
	languageName = "go"
	implName     = "exact-integer planner"
)

// The one capability this artifact implements. A worker request for anything else is answered
// `unsupported` and the loop stays alive: the host launches one worker per capability, so the field
// only exists to catch a wiring mistake.
const capFetchPlan = "fetch.plan"

// A 10 KB document arrives as one line; the scanner buffer is generous so that no legal input is
// truncated. A longer line is read in full anyway rather than mis-parsed.
const maxLineBytes = 64 << 20

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	capability := ""
	selfcheck := false
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--selfcheck":
			selfcheck = true
		case "--capability":
			if i+1 >= len(args) {
				fmt.Fprintln(stderr, "error: --capability requires a capability name")
				return 2
			}
			capability = args[i+1]
			i++
		default:
			fmt.Fprintf(stderr, "error: unrecognised argument %q; usage: vmlfetch --capability fetch.plan|--selfcheck\n", args[i])
			return 2
		}
	}

	// The built-in case list needs no argument, and it is what makes this worker testable on its own.
	if selfcheck {
		if runSelfCheck(stdout, stderr) {
			return 0
		}
		return 1
	}

	if capability == "" {
		fmt.Fprintln(stderr, "error: --capability <name> is required; usage: vmlfetch --capability fetch.plan|--selfcheck")
		return 2
	}
	if capability != capFetchPlan {
		fmt.Fprintf(stderr, "error: unknown capability %q; this artifact implements %s\n", capability, capFetchPlan)
		return 2
	}

	serve(capability, stdin, stdout, stderr)
	return 0
}

// serve is the request loop. A malformed line is answered with ok:false (the contract: "ok:false is a
// normal answer") and the loop keeps going; a broken pipe on stdout ends it. Every response is written
// with a single Write and no buffering, so a pipelined host sees each answer as it is produced.
func serve(capability string, stdin io.Reader, stdout, stderr io.Writer) {
	reader := bufio.NewReaderSize(stdin, 1<<16)
	for {
		line, err := readLine(reader)
		if len(line) > 0 {
			response := handleLine(line, capability)
			if _, werr := stdout.Write(append(response, '\n')); werr != nil {
				fmt.Fprintf(stderr, "error: cannot write to stdout: %v\n", werr)
				return
			}
			if isShutdownRequest(line) {
				return
			}
		}
		if err != nil {
			if err != io.EOF {
				fmt.Fprintf(stderr, "error: cannot read stdin: %v\n", err)
			}
			return
		}
	}
}

// readLine reads one line, stripping the LF and an optional CR, so that a CRLF host is tolerated even
// though the transport is LF. A line longer than the reader's buffer is returned in full.
func readLine(reader *bufio.Reader) ([]byte, error) {
	var line []byte
	for {
		chunk, err := reader.ReadSlice('\n')
		if len(chunk) > 0 {
			if line == nil {
				line = append([]byte(nil), chunk...)
			} else {
				line = append(line, chunk...)
			}
		}
		if err == bufio.ErrBufferFull {
			continue
		}
		if err != nil {
			return trimLineEnd(line), err
		}
		return trimLineEnd(line), nil
	}
}

func trimLineEnd(line []byte) []byte {
	for len(line) > 0 && (line[len(line)-1] == '\n' || line[len(line)-1] == '\r') {
		line = line[:len(line)-1]
	}
	return line
}

// request is the envelope of one protocol line. Unknown members are ignored on purpose: the
// contract's error set is about input shape, not about extra keys.
type request struct {
	ID         json.RawMessage `json:"id"`
	Op         *string         `json:"op"`
	Capability *string         `json:"capability"`
	Input      json.RawMessage `json:"input"`
}

func handleLine(line []byte, capability string) []byte {
	if len(bytes.TrimSpace(line)) == 0 {
		// A blank line is not a request object; answer without an id rather than dying.
		return encodeError([]byte("null"), "bad-input", "request line is empty")
	}
	var req request
	if err := json.Unmarshal(line, &req); err != nil {
		return encodeError([]byte("null"), "bad-input", "request is not a JSON object: "+err.Error())
	}
	if req.Op == nil {
		return encodeError(rawID(req.ID), "bad-input", "request.op must be a string")
	}
	id := rawID(req.ID)
	switch *req.Op {
	case "describe":
		return encodeDescribe(id, capability, languageName, implName, runtime.Version())
	case "shutdown":
		// The contract shows {"id":<id>,"ok":true} for shutdown and nothing more; that is what this
		// worker answers, and it is the last line it writes.
		return encodeShutdownAck(id)
	case "invoke":
		return handleInvoke(id, req, capability)
	default:
		return encodeError(id, "unsupported", "unsupported op "+*req.Op)
	}
}

// isShutdownRequest reports whether the line asked for shutdown, checked after the answer was
// written.
func isShutdownRequest(line []byte) bool {
	var probe struct {
		Op *string `json:"op"`
	}
	if err := json.Unmarshal(line, &probe); err != nil || probe.Op == nil {
		return false
	}
	return *probe.Op == "shutdown"
}

func handleInvoke(id []byte, req request, capability string) []byte {
	if req.Capability == nil || *req.Capability == "" {
		return encodeError(id, "bad-input", "invoke.capability must be a string")
	}
	if *req.Capability != capability {
		return encodeError(id, "unsupported", "this worker implements "+capability+", not "+*req.Capability)
	}
	if len(req.Input) == 0 || string(req.Input) == "null" {
		return encodeError(id, "bad-input", "invoke.input must be an object")
	}

	output, err := invokeCapability(capability, req.Input)
	if err != nil {
		if isBadInput(err) {
			return encodeError(id, "bad-input", err.Error())
		}
		return encodeError(id, "internal", err.Error())
	}
	return encodeSuccessOutput(id, output)
}

// invokeCapability decodes the input value and runs the capability. A panic is reported as `internal`
// rather than killing the worker, so one bad case cannot take down a whole corpus run.
func invokeCapability(capability string, input json.RawMessage) (output []byte, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("panic in %s: %v", capability, r)
		}
	}()

	switch capability {
	case capFetchPlan:
		value, decodeErr := decodeValue(input)
		if decodeErr != nil {
			return nil, badInput("input must be a JSON object: " + decodeErr.Error())
		}
		result, planErr := plan(value)
		if planErr != nil {
			return nil, planErr
		}
		return encodePlanOutput(result), nil
	}
	return nil, fmt.Errorf("unknown capability %s", capability)
}
