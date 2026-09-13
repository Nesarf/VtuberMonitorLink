package main

// selfcheck.go: the built-in case list behind --selfcheck (docs/WORKERS.md section 1.1).
//
// One English line per case, then "N/M checks passed", exit non-zero on failure. No protocol traffic
// on stdout in this mode: these lines are the whole stdout. The failing case prints the expected and
// the actual JSON so a divergence can be read without a debugger.
//
// The expectations here are written out as literal JSON strings (not recomputed from the code) so
// that changing a rule without changing a case fails the case.

import (
	"encoding/json"
	"fmt"
	"io"
)

type checkCase struct {
	name       string
	capability string
	// input is the protocol "input" object, as the raw JSON the host would send.
	input string
	// want is the expected output object as a JSON string; "" means "use wantFn".
	want string
	// wantFn, when set, computes the expectation from the actual output (idempotency).
	wantFn func(actual string) (string, error)
}

func checkCases() []checkCase {
	return []checkCase{
		{
			name:       "normalize/empty input stays empty",
			capability: capNormalize,
			input:      `{"text":""}`,
			want:       `{"text":""}`,
		},
		{
			name:       "normalize/full-width ASCII, ideographic space, em dash, apostrophe, ellipsis",
			capability: capNormalize,
			input:      "{\"text\":\"\uFF23\uFF41\uFF46\uFF45\u3000\u2014\u3000L\u2019\uFF25T\uFF25\u2026\"}",
			want:       `{"text":"cafe - l'ete..."}`,
		},
		{
			name:       "normalize/steps compose: E-acute is lowercased then folded",
			capability: capNormalize,
			input:      "{\"text\":\"L'\u00C9T\u00C9 \u00C9\"}",
			want:       `{"text":"l'ete e"}`,
		},
		{
			name:       "normalize/zero-width characters are deleted",
			capability: capNormalize,
			input:      "{\"text\":\"a\u200Bb\u200Dc\uFEFFd\"}",
			want:       `{"text":"abcd"}`,
		},
		{
			name:       "normalize/combining marks are deleted, so NFD equals NFC",
			capability: capNormalize,
			input:      "{\"text\":\"e\u0301 \u00E9\"}",
			want:       `{"text":"e e"}`,
		},
		{
			name:       "normalize/tab, LF and CR collapse to a single space",
			capability: capNormalize,
			input:      `{"text":"a\t\tb\n\nc\r\nd   e"}`,
			want:       `{"text":"a b c d e"}`,
		},
		{
			name:       "normalize/fold table applies after lowercasing (L-stroke, O-acute, Z-dot)",
			capability: capNormalize,
			input:      "{\"text\":\"\u0141\u00F3d\u017A   \u017B\u00D3\u0141\u0106\"}",
			want:       `{"text":"lodz zolc"}`,
		},
		{
			name:       "normalize/U+0130 folds through the fold table to i",
			capability: capNormalize,
			input:      "{\"text\":\"A\u0130B\"}",
			want:       `{"text":"aib"}`,
		},
		{
			name:       "normalize/Han, kana and Cyrillic pass through untouched",
			capability: capNormalize,
			input:      "{\"text\":\"\u6F22\u5B57\u3068\u3072\u3089\u304C\u306A \u041F\u0440\u0438\u0432\u0435\u0442\"}",
			want:       "{\"text\":\"\u6F22\u5B57\u3068\u3072\u3089\u304C\u306A \u041F\u0440\u0438\u0432\u0435\u0442\"}",
		},
		{
			name:       "normalize/idempotency: two-character folds must not re-enter the table",
			capability: capNormalize,
			input:      "{\"text\":\"\u00DF\u00C6\u00D8\u00DE\"}",
			wantFn:     idempotencyExpectation,
		},
		{
			name:       "normalize/idempotency: already-normalized text is unchanged",
			capability: capNormalize,
			input:      `{"text":"a b c"}`,
			wantFn:     idempotencyExpectation,
		},
		{
			name:       "extract/empty input yields the empty document",
			capability: capExtract,
			input:      `{"html":"","baseUrl":null}`,
			want:       `{"title":"","text":"","links":[],"images":0}`,
		},
		{
			name:       "extract/unclosed tag at end of input is dropped as a tag, newline included",
			capability: capExtract,
			input:      `{"html":"<p>a</p><div class=\"x\"","baseUrl":null}`,
			want:       `{"title":"","text":"\na\n","links":[],"images":0}`,
		},
		{
			name:       "extract/entities with and without a semicolon, numeric entities, no backtracking",
			capability: capExtract,
			input:      `{"html":"<p>&amp; &amp &lt &#65; &#x42; &#X43; &copy2024 &ampersand &unknown; &nbsp;</p>","baseUrl":null}`,
			want:       "{\"title\":\"\",\"text\":\"\\n& & < A B C &copy2024 &ampersand &unknown; \u00A0\\n\",\"links\":[],\"images\":0}",
		},
		{
			name:       "extract/removed elements, comment, CDATA, title, links, images",
			capability: capExtract,
			input:      `{"html":"<script>var x=1<\/script><style>p{}</style><!-- c --><title>T &amp; t</title><p>Hi <b>there</b></p><a href=\"nohref\">In</a><a href=\"/local\">In <i>link</i></a><a href=\"https://x.example/a\">Out</a><img src=a><img/>","baseUrl":null}`,
			want:       `{"title":"T & t","text":"\nHi there\nInIn linkOut","links":[{"href":"nohref","absolute":false,"text":"In"},{"href":"/local","absolute":false,"text":"In link"},{"href":"https://x.example/a","absolute":true,"text":"Out"}],"images":2}`,
		},
		{
			name:       "extract/quote rules: '>' inside an attribute does not end the tag, '<' of '<3' is text",
			capability: capExtract,
			input:      `{"html":"<a href=\"/a>b\">x</a> 2<3","baseUrl":null}`,
			want:       `{"title":"","text":"x 2<3","links":[{"href":"/a>b","absolute":false,"text":"x"}],"images":0}`,
		},
		{
			name:       "extract/nested anchors: the outer is reported at the inner tag, the inner becomes the open one",
			capability: capExtract,
			input:      `{"html":"<a href=\"/one\">one<a href=\"/two\">two","baseUrl":null}`,
			want:       `{"title":"","text":"onetwo","links":[{"href":"/one","absolute":false,"text":"one"},{"href":"/two","absolute":false,"text":"two"}],"images":0}`,
		},
		{
			name:       "extract/unclosed tag exactly at eof and a lone '<' at eof",
			capability: capExtract,
			input:      `{"html":"abc<b","baseUrl":null}`,
			want:       `{"title":"","text":"abc","links":[],"images":0}`,
		},
		{
			name:       "extract/a lone '<' at eof is literal text",
			capability: capExtract,
			input:      `{"html":"a<","baseUrl":null}`,
			want:       `{"title":"","text":"a<","links":[],"images":0}`,
		},
		{
			name:       "extract/a tag name alone at eof contributes no newline",
			capability: capExtract,
			input:      `{"html":"<p","baseUrl":null}`,
			want:       `{"title":"","text":"","links":[],"images":0}`,
		},
		{
			name:       "extract/an unclosed tag whose last '>' belongs to a quoted value is still unclosed (fuzz seed 7 case 2)",
			capability: capExtract,
			input:      `{"html":"<br><p title=\"unclosed&#X41</div>","baseUrl":null}`,
			want:       `{"title":"","text":"\n","links":[],"images":0}`,
		},
		{
			name:       "extract/a CDATA body inside an anchor belongs to the link text too (fuzz seed 7 case 1)",
			capability: capExtract,
			input:      `{"html":"<br><a href=\"x\"><img src=\"i.png\" alt=\"t\"><br/><![CDATA[<b>raw</b>]]></a>debut\u01c4debut< p><script src=\"a>b\"><br/>","baseUrl":null}`,
			want:       `{"title":"","text":"\n\n<b>raw</b>debutǄdebut< p>","links":[{"href":"x","absolute":false,"text":"\n<b>raw</b>"}],"images":1}`,
		},
		{
			name:       "extract/a CDATA body inside an anchor reaches the body text and the link text alike",
			capability: capExtract,
			input:      `{"html":"<a href=\"/x\"><![CDATA[<b>raw</b>]]></a>","baseUrl":null}`,
			want:       `{"title":"","text":"<b>raw</b>","links":[{"href":"/x","absolute":false,"text":"<b>raw</b>"}],"images":0}`,
		},
		{
			name:       "extract/CDATA is character data: its markup is not re-parsed",
			capability: capExtract,
			input:      `{"html":"<![CDATA[<b>raw</b>]]>","baseUrl":null}`,
			want:       `{"title":"","text":"<b>raw</b>","links":[],"images":0}`,
		},
		{
			name:       "extract/an unclosed CDATA runs to the end of input",
			capability: capExtract,
			input:      `{"html":"<![CDATA[unclosed","baseUrl":null}`,
			want:       `{"title":"","text":"unclosed","links":[],"images":0}`,
		},
		{
			name:       "extract/nothing inside CDATA is interpreted, entities included",
			capability: capExtract,
			input:      `{"html":"<![CDATA[a &amp; b &#65;]]>","baseUrl":null}`,
			want:       `{"title":"","text":"a &amp; b &#65;","links":[],"images":0}`,
		},
		{
			name:       "extract/removal wins over CDATA: a real <script> goes even when its content is CDATA",
			capability: capExtract,
			input:      `{"html":"<p><![CDATA[<script>x</script>]]></p><script>&lt;![CDATA[y]]&gt;</script>","baseUrl":null}`,
			want:       `{"title":"","text":"\n<script>x</script>\n","links":[],"images":0}`,
		},
		{
			name:       "extract/a CDATA section inside a removed element goes with it",
			capability: capExtract,
			input:      `{"html":"<script><![CDATA[gone]]></script>keep","baseUrl":null}`,
			want:       `{"title":"","text":"keep","links":[],"images":0}`,
		},
		{
			name:       "extract/a title inside an anchor belongs to the title alone",
			capability: capExtract,
			input:      `{"html":"<a href=\"/x\"><title>T</title>t</a>","baseUrl":null}`,
			want:       `{"title":"T","text":"t","links":[{"href":"/x","absolute":false,"text":"t"}],"images":0}`,
		},
		{
			name:       "extract/a title inside an anchor still takes no CDATA body (title text is exclusive)",
			capability: capExtract,
			input:      `{"html":"<a href=\"/x\"><title>T<![CDATA[q]]></title>t</a>","baseUrl":null}`,
			want:       `{"title":"Tq","text":"t","links":[{"href":"/x","absolute":false,"text":"t"}],"images":0}`,
		},
		{
			name:       "extract/hex reference decodes to its own character (&#x2014; is U+2014, not '-')",
			capability: capExtract,
			input:      `{"html":"a &#x2014; b &#8212; c","baseUrl":null}`,
			want:       "{\"title\":\"\",\"text\":\"a \u2014 b \u2014 c\",\"links\":[],\"images\":0}",
		},
		{
			name:       "fingerprint/CJK bigrams plus a Latin run",
			capability: capFingerprint,
			input:      "{\"text\":\"openai gpt \u5DF2\u7ECF \u5DF2\u7ECF\"}",
			want:       `{"simhash":"2a000d8009183078","tokens":4,"shingles":2}`,
		},
		{
			name:       "fingerprint/a single token is the single shingle and hashes alone",
			capability: capFingerprint,
			input:      `{"text":"x"}`,
			want:       `{"simhash":"af63f54c86021707","tokens":1,"shingles":1}`,
		},
		{
			name:       "fingerprint/empty text has no tokens and no shingles",
			capability: capFingerprint,
			input:      `{"text":""}`,
			want:       `{"simhash":"0000000000000000","tokens":0,"shingles":0}`,
		},
		{
			name:       "fingerprint/edge punctuation is stripped from tokens",
			capability: capFingerprint,
			input:      `{"text":"hello, hello... (world)"}`,
			wantFn:     sameAsBareWords,
		},
		{
			name:       "fingerprint/punctuation-only tokens emit nothing",
			capability: capFingerprint,
			input:      `{"text":"... !!! a"}`,
			want:       `{"simhash":"af63dc4c8601ec8c","tokens":1,"shingles":1}`,
		},
		{
			name:       "cross-capability/NFC and NFD forms of the same text normalize identically",
			capability: capNormalize,
			input:      "{\"text\":\"\u0130stanbul caf\u00E9 NFD-e\u0301\"}",
			want:       `{"text":"istanbul cafe nfd-e"}`,
		},
	}
}

// idempotencyExpectation asserts normalize(normalize(x)) == normalize(x): the second normalization
// must equal the first byte for byte, which is the contract's idempotency invariant.
func idempotencyExpectation(actual string) (string, error) {
	var first struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal([]byte(actual), &first); err != nil {
		return "", fmt.Errorf("output is not a JSON object: %v", err)
	}
	second, err := invokeCapability(capNormalize, json.RawMessage("{\"text\":"+mustJSONString(first.Text)+"}"))
	if err != nil {
		return "", fmt.Errorf("second normalization failed: %v", err)
	}
	if string(second) != actual {
		return "", fmt.Errorf("not idempotent: first=%s second=%s", actual, second)
	}
	return actual, nil
}

// sameAsBareWords asserts that stripping edge punctuation did not change the fingerprint of the
// words themselves: "hello, hello... (world)" must fingerprint exactly like "hello hello world".
func sameAsBareWords(actual string) (string, error) {
	bare, err := invokeCapability(capFingerprint, json.RawMessage(`{"text":"hello hello world"}`))
	if err != nil {
		return "", fmt.Errorf("bare-words fingerprint failed: %v", err)
	}
	var got, want fingerprintOutput
	if err := json.Unmarshal([]byte(actual), &got); err != nil {
		return "", fmt.Errorf("output is not a fingerprint object: %v", err)
	}
	if err := json.Unmarshal(bare, &want); err != nil {
		return "", fmt.Errorf("bare-words output is not a fingerprint object: %v", err)
	}
	if got != want {
		return "", fmt.Errorf("punctuation changed the fingerprint: %s vs %s", actual, bare)
	}
	return actual, nil
}

func mustJSONString(s string) string {
	encoded, err := json.Marshal(s)
	if err != nil {
		panic(err)
	}
	return string(encoded)
}

// runSelfCheck returns true when every case passed. It writes one English line per case plus the
// summary, and never writes anything to the protocol stream.
func runSelfCheck(stdout, stderr io.Writer) bool {
	cases := checkCases()
	passed := 0
	for _, c := range cases {
		actual, err := invokeCapability(c.capability, json.RawMessage(c.input))
		if err != nil {
			fmt.Fprintf(stdout, "FAIL %s: %v\n", c.name, err)
			continue
		}
		if c.wantFn != nil {
			if _, err := c.wantFn(string(actual)); err != nil {
				fmt.Fprintf(stdout, "FAIL %s: %v\n", c.name, err)
				continue
			}
			passed++
			fmt.Fprintf(stdout, "ok   %s\n", c.name)
			continue
		}
		if string(actual) != c.want {
			fmt.Fprintf(stdout, "FAIL %s\n", c.name)
			fmt.Fprintf(stdout, "       expected: %s\n", c.want)
			fmt.Fprintf(stdout, "       actual:   %s\n", string(actual))
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
