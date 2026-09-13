package main

// fingerprint.go implements docs/WORKERS.md section 4, capability text.fingerprint.
//
// Everything is integer arithmetic on purpose ("byte-identical across languages is achievable rather
// than aspirational"). The hash is FNV-1a 64-bit with wraparound multiply; the simhash is 64
// counters with a tie counting as 0.

import (
	"strings"
)

const (
	fnvOffset64 = 14695981039346656037
	fnvPrime64  = 1099511628211 // multiplication wraps modulo 2^64 by the uint64 type itself
)

// fingerprintOutput is the shape of the text.fingerprint output object, fields in contract order.
type fingerprintOutput struct {
	Simhash  string `json:"simhash"`
	Tokens   int    `json:"tokens"`
	Shingles int    `json:"shingles"`
}

func fingerprintText(text string) fingerprintOutput {
	tokens := tokenizeForFingerprint(text)
	shingles := shinglesOf(tokens)

	var counters [64]int64
	for _, shingle := range shingles {
		hash := fnv1a64(shingle)
		for i := 0; i < 64; i++ {
			if hash&(uint64(1)<<uint(i)) != 0 {
				counters[i]++
			} else {
				counters[i]--
			}
		}
	}

	// "Bit i of the output is 1 when its counter is > 0, and 0 on a tie." With no shingles every
	// counter is 0, so the output is 16 zeros.
	var out uint64
	for i := 0; i < 64; i++ {
		if counters[i] > 0 {
			out |= uint64(1) << uint(i)
		}
	}
	return fingerprintOutput{
		Simhash:  hex16(out),
		Tokens:   len(tokens),
		Shingles: len(shingles),
	}
}

// tokenizeForFingerprint splits on single spaces and turns every token into the code-point runs the
// contract describes: CJK runs of 1 emit themselves, CJK runs of n >= 2 emit their n-1 overlapping
// bigrams, "other" runs emit themselves.
//
// Leading and trailing ASCII punctuation is stripped from the token FIRST, so "hello," and "hello"
// emit the same token - otherwise every title that ends in a full stop would be its own duplicate as
// far as the fingerprint is concerned. A token that is empty after that stripping emits nothing, so
// a punctuation-only token can never reach the run rule. The maps are never iterated.
func tokenizeForFingerprint(text string) []string {
	var out []string
	for _, token := range strings.Split(text, " ") {
		if token == "" {
			continue
		}
		trimmed := trimAsciiPunctuation(token)
		if trimmed == "" {
			continue
		}
		runStart := 0
		runClass := -1
		tokenRunes := []rune(trimmed)
		for i := 0; i <= len(tokenRunes); i++ {
			class := -1
			if i < len(tokenRunes) {
				class = fingerprintClass(tokenRunes[i])
			}
			if class == runClass {
				continue
			}
			out = append(out, emitRun(tokenRunes[runStart:i], runClass)...)
			runStart = i
			runClass = class
		}
	}
	return out
}

// trimAsciiPunctuation removes leading and trailing characters of the contract's ASCII punctuation
// set. The strip is byte-wise because the whole set is ASCII, so a multi-byte code point can never
// be mistaken for punctuation.
func trimAsciiPunctuation(token string) string {
	start := 0
	for start < len(token) && isAsciiPunctuationByte(token[start]) {
		start++
	}
	end := len(token)
	for end > start && isAsciiPunctuationByte(token[end-1]) {
		end--
	}
	return token[start:end]
}

func emitRun(runes []rune, class int) []string {
	if class < 0 || len(runes) == 0 {
		return nil
	}
	if class == classOther {
		return []string{string(runes)}
	}
	if len(runes) == 1 {
		return []string{string(runes)}
	}
	bigrams := make([]string, 0, len(runes)-1)
	for i := 0; i+1 < len(runes); i++ {
		bigrams = append(bigrams, string(runes[i:i+2]))
	}
	return bigrams
}

const (
	classOther = iota
	classCJK
)

// fingerprintClass is contract section 4: Han U+3400-U+4DBF, U+4E00-U+9FFF, U+F900-U+FAFF; kana
// U+3040-U+30FF; Hangul U+AC00-U+D7AF. Everything else is "other".
func fingerprintClass(r rune) int {
	switch {
	case r >= 0x3400 && r <= 0x4DBF:
		return classCJK
	case r >= 0x4E00 && r <= 0x9FFF:
		return classCJK
	case r >= 0xF900 && r <= 0xFAFF:
		return classCJK
	case r >= 0x3040 && r <= 0x30FF:
		return classCJK
	case r >= 0xAC00 && r <= 0xD7AF:
		return classCJK
	}
	return classOther
}

// asciiPunctuation is exactly the contract's list.
const asciiPunctuation = "!?,.;:'\"()[]{}<>-_/\\|*+=~`@#$%^&"

func isAsciiPunctuationByte(c byte) bool {
	return strings.IndexByte(asciiPunctuation, c) >= 0
}

// shinglesOf is contract section 4: overlapping runs of 3 consecutive emitted tokens; fewer than 3
// tokens make the whole token list joined by a space the single shingle; no tokens make none.
func shinglesOf(tokens []string) []string {
	switch {
	case len(tokens) == 0:
		return nil
	case len(tokens) < 3:
		return []string{strings.Join(tokens, " ")}
	}
	shingles := make([]string, 0, len(tokens)-2)
	for i := 0; i+3 <= len(tokens); i++ {
		shingles = append(shingles, tokens[i]+" "+tokens[i+1]+" "+tokens[i+2])
	}
	return shingles
}

// fnv1a64 is exactly the loop the contract gives, over the shingle's UTF-8 bytes.
func fnv1a64(s string) uint64 {
	h := uint64(fnvOffset64)
	for i := 0; i < len(s); i++ {
		h ^= uint64(s[i])
		h *= fnvPrime64
	}
	return h
}

const hexDigits = "0123456789abcdef"

// hex16 formats 16 lowercase hex characters, zero padded. Formatting is manual so that no
// locale-dependent number formatting can ever reach the output.
func hex16(value uint64) string {
	var buf [16]byte
	for i := 15; i >= 0; i-- {
		buf[i] = hexDigits[value&0xF]
		value >>= 4
	}
	return string(buf[:])
}
