package main

// selfcheck.go - the built-in case list behind --selfcheck (docs/WORKERS.md section 1.1).
//
// One English line per case, then "N/M checks passed", exit non-zero on failure. No protocol traffic
// on stdout in this mode: these lines are the whole stdout. A failing case prints the expected and the
// actual JSON, so a divergence can be read without a debugger, and the whole-answer case covers the
// key order on purpose, because key order is part of the contract.
//
// The expectations are literal JSON strings, not values recomputed from the code: changing a rule
// without changing a case fails the case. Every case runs through invokeCapability, the same entry
// point the protocol uses, so the check covers decoding, planning and encoding together.
//
// Two expectations carry a non-ASCII character, and both are written as the characters themselves: a
// dotted e-acute in an egress name, and an astral id beside U+FFFD. The file is UTF-8, the transport
// is UTF-8 bytes, and the encoder writes raw UTF-8 in the output, so the expectations are too. JSON
// escape sequences would be an option for the input side only, and are a trap in a check: `\uFFFD`
// beside `\uFFFD` decodes to two U+FFFD characters, which is exactly how this case first went wrong.
//
// The traps the contract names each have their own case here: `lastRunAt: 0` is a timestamp (twice:
// not due, then due at the inclusive boundary); a source on an unknown egress is skipped even when it
// is not due; ordering is by UTF-8 bytes, not a locale collation and not UTF-16 code units; a shared
// budget is spent in ascending byte order of the egress name; a Go map iteration order must never
// reach the answer (checked by planning one input 200 times and comparing the bytes); and the counts
// have to be the lengths of the lists.

import (
	"encoding/json"
	"fmt"
	"io"
)

type checkCase struct {
	name  string
	input string
	want  string
	// unstable marks the case that is checked by repetition rather than by one run: see
	// repeatedPlanIsStable.
	unstable bool
}

func checkCases() []checkCase {
	return []checkCase{
		{
			name:  "an empty plan is a valid plan",
			input: `{"now":0,"sources":[],"egress":{"direct":{}}}`,
			want:  `{"batches":[],"deferred":[],"skipped":[],"counts":{"planned":0,"deferred":0,"skipped":0}}`,
		},
		{
			name:  "a never-run source has waited longest and leads the batch",
			input: `{"now":1000000,"sources":[{"id":"recent","egress":"direct","lastRunAt":999000,"minIntervalMs":0},{"id":"fresh","egress":"direct","lastRunAt":null,"minIntervalMs":600000}],"egress":{"direct":{"maxConcurrent":4}}}`,
			want:  `{"batches":[{"egress":"direct","sources":["fresh","recent"]}],"deferred":[],"skipped":[],"counts":{"planned":2,"deferred":0,"skipped":0}}`,
		},
		{
			name:  "lastRunAt 0 is the epoch, not a missing value: it is not due yet",
			input: `{"now":500,"sources":[{"id":"a","egress":"direct","lastRunAt":0,"minIntervalMs":1000}],"egress":{"direct":{}}}`,
			want:  `{"batches":[],"deferred":[{"id":"a","reason":"interval"}],"skipped":[],"counts":{"planned":0,"deferred":1,"skipped":0}}`,
		},
		{
			name:  "lastRunAt 0 is due once the interval has passed, boundary inclusive",
			input: `{"now":1000,"sources":[{"id":"a","egress":"direct","lastRunAt":0,"minIntervalMs":1000}],"egress":{"direct":{}}}`,
			want:  `{"batches":[{"egress":"direct","sources":["a"]}],"deferred":[],"skipped":[],"counts":{"planned":1,"deferred":0,"skipped":0}}`,
		},
		{
			name:  "due true overrides the interval",
			input: `{"now":1000,"sources":[{"id":"a","egress":"direct","due":true,"lastRunAt":999,"minIntervalMs":600000}],"egress":{"direct":{}}}`,
			want:  `{"batches":[{"egress":"direct","sources":["a"]}],"deferred":[],"skipped":[],"counts":{"planned":1,"deferred":0,"skipped":0}}`,
		},
		{
			name:  "a source on an unknown egress is skipped even when it is not due",
			input: `{"now":0,"sources":[{"id":"a","egress":"nope","due":false,"lastRunAt":5000}],"egress":{"direct":{}}}`,
			want:  `{"batches":[],"deferred":[],"skipped":[{"id":"a","reason":"no-egress"}],"counts":{"planned":0,"deferred":0,"skipped":1}}`,
		},
		{
			name:  "a missing egress object skips every source",
			input: `{"now":0,"sources":[{"id":"a","egress":"direct","lastRunAt":null}]}`,
			want:  `{"batches":[],"deferred":[],"skipped":[{"id":"a","reason":"no-egress"}],"counts":{"planned":0,"deferred":0,"skipped":1}}`,
		},
		{
			name:  "a future lastRunAt waits, and a missing interval is zero",
			input: `{"now":1000,"sources":[{"id":"future","egress":"direct","lastRunAt":5000,"minIntervalMs":0},{"id":"ran","egress":"direct","lastRunAt":999}],"egress":{"direct":{"maxConcurrent":4}}}`,
			want:  `{"batches":[{"egress":"direct","sources":["ran"]}],"deferred":[{"id":"future","reason":"interval"}],"skipped":[],"counts":{"planned":1,"deferred":1,"skipped":0}}`,
		},
		{
			name:  "a missing maxConcurrent is one lane, and the rest is a budget deferral",
			input: `{"now":0,"sources":[{"id":"a","egress":"direct","lastRunAt":null},{"id":"b","egress":"direct","lastRunAt":null}],"egress":{"direct":{}}}`,
			want:  `{"batches":[{"egress":"direct","sources":["a"]}],"deferred":[{"id":"b","reason":"budget"}],"skipped":[],"counts":{"planned":1,"deferred":1,"skipped":0}}`,
		},
		{
			name:  "batches come out in UTF-8 byte order of the egress name, not a collation",
			input: `{"now":0,"sources":[{"id":"a","egress":"\u00e9clair","lastRunAt":null},{"id":"b","egress":"zebra","lastRunAt":null}],"egress":{"\u00e9clair":{},"zebra":{}}}`,
			want:  `{"batches":[{"egress":"zebra","sources":["b"]},{"egress":"éclair","sources":["a"]}],"deferred":[],"skipped":[],"counts":{"planned":2,"deferred":0,"skipped":0}}`,
		},
		{
			name: "ids of equal age are ordered by UTF-8 bytes, not by UTF-16 code units",
			// The second id is an astral character written as a surrogate pair: U+FFFD is three UTF-8
			// bytes (EF BF BD) and the astral character is four (F0 9F 98 80), so byte order puts
			// U+FFFD first. UTF-16 code-unit order - a JVM's or .NET's default string order - puts
			// the astral character's leading surrogate (D83D) first instead.
			input: `{"now":10,"sources":[{"id":"😀","egress":"direct","lastRunAt":5},{"id":"�","egress":"direct","lastRunAt":5}],"egress":{"direct":{"maxConcurrent":2}}}`,
			want:  `{"batches":[{"egress":"direct","sources":["�","😀"]}],"deferred":[],"skipped":[],"counts":{"planned":2,"deferred":0,"skipped":0}}`,
		},
		{
			name:  "a shared budget is spent in ascending byte order of the egress name",
			input: `{"now":0,"sources":[{"id":"a","egress":"bravo","lastRunAt":null},{"id":"b","egress":"alpha","lastRunAt":null}],"egress":{"alpha":{},"bravo":{}},"budget":{"maxRequests":1}}`,
			want:  `{"batches":[{"egress":"alpha","sources":["b"]}],"deferred":[{"id":"a","reason":"budget"}],"skipped":[],"counts":{"planned":1,"deferred":1,"skipped":0}}`,
		},
		{
			name:  "maxPerEgress is applied before maxConcurrent",
			input: `{"now":0,"sources":[{"id":"s1","egress":"tor","lastRunAt":null},{"id":"s2","egress":"tor","lastRunAt":null},{"id":"s3","egress":"tor","lastRunAt":null}],"egress":{"tor":{"maxConcurrent":8}},"budget":{"maxPerEgress":{"tor":2}}}`,
			want:  `{"batches":[{"egress":"tor","sources":["s1","s2"]}],"deferred":[{"id":"s3","reason":"budget"}],"skipped":[],"counts":{"planned":2,"deferred":1,"skipped":0}}`,
		},
		{
			name:  "a budget of zero is a limit, not a missing value",
			input: `{"now":0,"sources":[{"id":"a","egress":"direct","lastRunAt":null}],"egress":{"direct":{}},"budget":{"maxRequests":0,"maxPerEgress":{"direct":0}}}`,
			want:  `{"batches":[],"deferred":[{"id":"a","reason":"budget"}],"skipped":[],"counts":{"planned":0,"deferred":1,"skipped":0}}`,
		},
		{
			name:  "an egress with nothing due gets no empty batch",
			input: `{"now":1000,"sources":[{"id":"a","egress":"direct","lastRunAt":900,"minIntervalMs":60000}],"egress":{"direct":{},"tor":{}}}`,
			want:  `{"batches":[],"deferred":[{"id":"a","reason":"interval"}],"skipped":[],"counts":{"planned":0,"deferred":1,"skipped":0}}`,
		},
		{
			name:  "both report lists are sorted by id as bytes, and the counts are the list lengths",
			input: `{"now":0,"sources":[{"id":"z","egress":"gone","lastRunAt":null},{"id":"a","egress":"gone","lastRunAt":null},{"id":"y","egress":"direct","lastRunAt":10,"minIntervalMs":60000},{"id":"b","egress":"direct","lastRunAt":10,"minIntervalMs":60000}],"egress":{"direct":{}}}`,
			want:  `{"batches":[],"deferred":[{"id":"b","reason":"interval"},{"id":"y","reason":"interval"}],"skipped":[{"id":"a","reason":"no-egress"},{"id":"z","reason":"no-egress"}],"counts":{"planned":0,"deferred":2,"skipped":2}}`,
		},
		{
			name:  "the whole answer is written in contract order, nested objects included",
			input: `{"now":100000,"sources":[{"id":"planned","egress":"direct","lastRunAt":null},{"id":"too-soon","egress":"direct","lastRunAt":99000,"minIntervalMs":60000},{"id":"broken","egress":"ghost","lastRunAt":null}],"egress":{"direct":{"maxConcurrent":4}}}`,
			want:  `{"batches":[{"egress":"direct","sources":["planned"]}],"deferred":[{"id":"too-soon","reason":"interval"}],"skipped":[{"id":"broken","reason":"no-egress"}],"counts":{"planned":1,"deferred":1,"skipped":1}}`,
		},
		{
			name: "200 identical runs produce identical bytes (no Go map order in the answer)",
			// Three egresses, four sources, and a shared budget of two: the batch order, the order the
			// budget is spent in, and the order the deferred list comes out in all depend on ordering
			// that a Go map would decide at random. The expected bytes are checked once and then
			// re-checked 199 times.
			input:    `{"now":0,"sources":[{"id":"c","egress":"direct","lastRunAt":null},{"id":"b","egress":"direct","lastRunAt":null},{"id":"a","egress":"tor","lastRunAt":null},{"id":"d","egress":"alpha","lastRunAt":null}],"egress":{"direct":{"maxConcurrent":2},"tor":{},"alpha":{}},"budget":{"maxRequests":2}}`,
			want:     `{"batches":[{"egress":"alpha","sources":["d"]},{"egress":"direct","sources":["b"]}],"deferred":[{"id":"a","reason":"budget"},{"id":"c","reason":"budget"}],"skipped":[],"counts":{"planned":2,"deferred":2,"skipped":0}}`,
			unstable: true,
		},
		{
			name:  "a missing sources array is bad input",
			input: `{"now":0,"egress":{}}`,
			want:  `{"__error":"bad-input"}`,
		},
		{
			name:  "a sources value that is not an array is bad input",
			input: `{"now":0,"sources":"nope","egress":{}}`,
			want:  `{"__error":"bad-input"}`,
		},
		{
			name:  "a missing now is bad input: the worker never reads its own clock",
			input: `{"sources":[],"egress":{}}`,
			want:  `{"__error":"bad-input"}`,
		},
		{
			name:  "a source without an id is bad input",
			input: `{"now":0,"sources":[{"egress":"direct"}],"egress":{"direct":{}}}`,
			want:  `{"__error":"bad-input"}`,
		},
		{
			name:  "maxConcurrent below one is bad input",
			input: `{"now":0,"sources":[{"id":"a","egress":"direct","lastRunAt":null}],"egress":{"direct":{"maxConcurrent":0}}}`,
			want:  `{"__error":"bad-input"}`,
		},
		{
			name:  "a negative budget is not a limit and is bad input",
			input: `{"now":0,"sources":[],"egress":{},"budget":{"maxRequests":-1}}`,
			want:  `{"__error":"bad-input"}`,
		},
		{
			name:  "a negative interval is bad input",
			input: `{"now":0,"sources":[{"id":"a","egress":"direct","lastRunAt":0,"minIntervalMs":-1}],"egress":{"direct":{}}}`,
			want:  `{"__error":"bad-input"}`,
		},
		{
			name:  "a lastRunAt that is neither an integer nor null is bad input",
			input: `{"now":0,"sources":[{"id":"a","egress":"direct","lastRunAt":1.5}],"egress":{"direct":{}}}`,
			want:  `{"__error":"bad-input"}`,
		},
		{
			name:  "a source with an empty id is bad input",
			input: `{"now":0,"sources":[{"id":"","egress":"direct"}],"egress":{"direct":{}}}`,
			want:  `{"__error":"bad-input"}`,
		},
		{
			name: "an egress name that is not a string is bad input, not a skip",
			// The corpus does not pin this one, so it is pinned here: the contract's `egress` is a
			// string, and section 10 says "anything outside those shapes is bad-input". Reading `5` as
			// "an egress that does not exist" and answering `no-egress` would turn a typo in the input
			// into a plausible-looking plan, which is the failure mode rule 1 exists to prevent. The
			// JavaScript reference skips it; that difference is written down in README.md rather than
			// hidden, and it is invisible to the corpus because no case sends a non-string egress.
			input: `{"now":0,"sources":[{"id":"a","egress":5}],"egress":{"direct":{}}}`,
			want:  `{"__error":"bad-input"}`,
		},
	}
}

// errorExpectation is how a case says "this input is bad-input": only the error code is comparable
// across languages, which is what the corpus compares too.
func errorExpectation(code string) string { return `{"__error":"` + code + `"}` }

// actualForCheck returns the case's answer as the comparable JSON string: the output object, or the
// `{"__error":code}` form when the capability rejected the input.
func actualForCheck(c checkCase) (string, error) {
	output, err := invokeCapability(capFetchPlan, json.RawMessage(c.input))
	if err != nil {
		if isBadInput(err) {
			return errorExpectation("bad-input"), nil
		}
		return "", err
	}
	return string(output), nil
}

// repeatedPlanIsStable plans the same input many times and compares the bytes. Go randomises map
// iteration order per range statement, so a plan that reads a map to decide the batch order - or the
// order a shared budget is spent in - is stable only until it is run enough times. This case is the
// check that catches it, and it is the reason the planner sorts a slice of egress names instead.
func repeatedPlanIsStable(input string, runs int) (string, error) {
	first, err := actualForCheck(checkCase{input: input})
	if err != nil {
		return "", err
	}
	for i := 1; i < runs; i++ {
		again, err := actualForCheck(checkCase{input: input})
		if err != nil {
			return "", err
		}
		if again != first {
			return "", fmt.Errorf("run %d differs: %s vs %s", i+1, first, again)
		}
	}
	return first, nil
}

// runSelfCheck returns true when every case passed. It writes one English line per case plus the
// summary, and never writes anything to the protocol stream.
func runSelfCheck(stdout, stderr io.Writer) bool {
	cases := checkCases()
	passed := 0
	for _, c := range cases {
		var actual string
		var err error
		if c.unstable {
			actual, err = repeatedPlanIsStable(c.input, 200)
		} else {
			actual, err = actualForCheck(c)
		}
		if err != nil {
			fmt.Fprintf(stdout, "FAIL %s: %v\n", c.name, err)
			continue
		}
		if actual != c.want {
			fmt.Fprintf(stdout, "FAIL %s\n", c.name)
			fmt.Fprintf(stdout, "       expected: %s\n", c.want)
			fmt.Fprintf(stdout, "       actual:   %s\n", actual)
			continue
		}
		passed++
		fmt.Fprintf(stdout, "ok   %s\n", c.name)
	}

	fmt.Fprintf(stdout, "%d/%d checks passed\n", passed, len(cases))
	if passed != len(cases) {
		fmt.Fprintf(stderr, "selfcheck failed: %d of %d cases did not pass\n", len(cases)-passed, len(cases))
		return false
	}
	return true
}
