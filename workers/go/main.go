package main

// main.go: the command line and the stdio request loop of docs/WORKERS.md section 1.1.
//
//	A worker process handles one capability, selected by --capability <name>.
//	--selfcheck runs the built-in case list instead of the protocol loop.
//	Anything else on the command line is an error on stderr with exit 2.
//
// stdout carries protocol lines and nothing else, ever; diagnostics are English text on stderr.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
)

const (
	languageName = "go"
	implName     = "table-driven"
)

// The three capabilities this artifact implements, in registry order.
const (
	capNormalize   = "text.normalize"
	capExtract     = "text.extract"
	capFingerprint = "text.fingerprint"
)

// A 10 KB document arrives as one line; the scanner buffer is generous so that no legal input is
// truncated. Lines longer than this are reported as a bad-input line rather than mis-parsed.
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
			fmt.Fprintf(stderr, "error: unrecognised argument %q; usage: vmltext.exe --capability <name>|--selfcheck\n", args[i])
			return 2
		}
	}

	loaded, err := LoadTables()
	if err != nil {
		fmt.Fprintf(stderr, "error: %v\n", err)
		return 2 // cannot run at all without the shared tables
	}
	tables = loaded

	if selfcheck {
		if runSelfCheck(stdout, stderr) {
			return 0
		}
		return 1
	}

	if capability == "" {
		fmt.Fprintln(stderr, "error: --capability <name> is required; usage: vmltext.exe --capability <name>|--selfcheck")
		return 2
	}
	if !isKnownCapability(capability) {
		fmt.Fprintf(stderr, "error: unknown capability %q; this artifact implements %s, %s, %s\n",
			capability, capNormalize, capExtract, capFingerprint)
		return 2
	}

	serve(capability, stdin, stdout, stderr)
	return 0
}

func isKnownCapability(name string) bool {
	switch name {
	case capNormalize, capExtract, capFingerprint:
		return true
	}
	return false
}

// serve is the request loop. A malformed line is answered with ok:false (the contract: "ok:false is
// a normal answer") and the loop keeps going; a broken pipe on stdout ends it.
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

// readLine reads one line, stripping the LF and an optional CR. A line longer than maxLineBytes is
// returned in full anyway (the reader keeps feeding), so nothing is silently truncated.
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
		return encodeDescribe(id, capability, languageName, implName, goRuntimeVersion())
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

// isShutdownRequest reports whether the line asked for shutdown, after the answer was written.
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
		if bad, ok := err.(*badInputError); ok {
			return encodeError(id, "bad-input", bad.Error())
		}
		return encodeError(id, "internal", err.Error())
	}
	return encodeSuccessOutput(id, output)
}

// badInputError marks an error the host should see as code "bad-input" rather than "internal".
type badInputError struct {
	message string
}

func (e *badInputError) Error() string { return e.message }

func badInput(format string, args ...interface{}) error {
	return &badInputError{message: fmt.Sprintf(format, args...)}
}

// invokeCapability dispatches on the capability and encodes the output in the contract's field
// order. A panic anywhere in the capability is reported as "internal" rather than killing the
// worker, so one bad case cannot take down a whole corpus run.
func invokeCapability(capability string, input json.RawMessage) (output []byte, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("panic in %s: %v", capability, r)
		}
	}()

	switch capability {
	case capNormalize:
		var in struct {
			Text *string `json:"text"`
		}
		if err := json.Unmarshal(input, &in); err != nil {
			return nil, badInput("input must be an object with a string field \"text\": %v", err)
		}
		if in.Text == nil {
			return nil, badInput("input.text must be a string")
		}
		return encodeNormalizeOutput(normalizeText(*in.Text)), nil

	case capExtract:
		var in struct {
			HTML    *string `json:"html"`
			BaseURL *string `json:"baseUrl"`
		}
		if err := json.Unmarshal(input, &in); err != nil {
			return nil, badInput("input must be an object with a string field \"html\": %v", err)
		}
		if in.HTML == nil {
			return nil, badInput("input.html must be a string")
		}
		// baseUrl is validated as a string-or-null and then unused: the contract keeps hrefs
		// verbatim and states that resolving URLs is out of scope for this capability.
		var base struct {
			BaseURL json.RawMessage `json:"baseUrl"`
		}
		_ = json.Unmarshal(input, &base)
		if len(base.BaseURL) > 0 && string(base.BaseURL) != "null" {
			var s string
			if err := json.Unmarshal(base.BaseURL, &s); err != nil {
				return nil, badInput("input.baseUrl must be a string or null")
			}
		}
		return encodeExtractOutput(extractHTML(*in.HTML, in.BaseURL)), nil

	case capFingerprint:
		var in struct {
			Text *string `json:"text"`
		}
		if err := json.Unmarshal(input, &in); err != nil {
			return nil, badInput("input must be an object with a string field \"text\": %v", err)
		}
		if in.Text == nil {
			return nil, badInput("input.text must be a string")
		}
		return encodeFingerprintOutput(fingerprintText(*in.Text)), nil
	}
	return nil, fmt.Errorf("unknown capability %s", capability)
}
