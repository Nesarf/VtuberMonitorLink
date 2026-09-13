package main

// normalize.go implements docs/WORKERS.md section 2, capability text.normalize.
//
// Step order is normative and is followed literally:
//   1 delete the listed code points (C0 controls minus tab/LF/CR, DEL, zero-width and bidi
//     controls, BOM, and the listed combining-mark ranges)
//   2 map the listed code points (incl. full-width ASCII -> ASCII by subtracting 0xFEE0)
//   3 lowercase, exactly and only per workers/spec/latin-lower.json
//   4 fold accents, exactly and only per workers/spec/latin-fold.json (ASCII, 1 or 2 chars)
//   5 collapse runs of space/tab/LF/CR into one space
//   6 trim leading and trailing spaces
//
// The three table steps COMPOSE: a code point the lower table maps (E-acute -> e-acute) is still
// folded afterwards (e-acute -> e). Both tables are load-bearing, and applying them as alternatives
// instead of steps was a real bug in the JavaScript reference (it passed "Cafe" and failed "L'ETE").
//
// No Unicode normalization of any kind is performed. unicode.ToLower, strings.ToLower and
// golang.org/x/text are deliberately not used: the contract says the shared tables are the rule and
// the runtime's own tables must not be consulted.

import (
	"strings"
	"unicode/utf8"
)

func normalizeText(in string) string {
	if !utf8.ValidString(in) {
		// The contract's transport is UTF-8 bytes; bytes that are not valid UTF-8 have no code
		// point, so they are replaced with U+FFFD exactly once each rather than dropped silently.
		in = strings.ToValidUTF8(in, "\uFFFD")
	}

	var b strings.Builder
	b.Grow(len(in))
	for _, r := range in {
		if isDeletedRune(r) {
			continue
		}
		if r == 0x2026 {
			// U+2026 HORIZONTAL ELLIPSIS -> "..." : the only one-to-many mapping in step 2.
			b.WriteString("...")
			continue
		}
		if mapped, ok := mapRune(r); ok {
			r = mapped
		}
		var folded []byte
		if r >= 0 && int(r) < len(tables.lower) {
			if entry := tables.lower[r]; entry != nil {
				r = entry.target
			}
		}
		if r >= 0 && int(r) < len(tables.fold) {
			if entry := tables.fold[r]; entry != nil {
				folded = entry.target
			}
		}
		if folded != nil {
			b.Write(folded)
			continue
		}
		b.WriteRune(r)
	}
	return trimAndCollapseSpaces(b.String())
}

// isDeletedRune is contract step 1.
func isDeletedRune(r rune) bool {
	switch {
	case r >= 0x0000 && r <= 0x0008:
		return true
	case r == 0x000B || r == 0x000C:
		return true
	case r >= 0x000E && r <= 0x001F:
		return true
	case r == 0x007F:
		return true
	case r >= 0x0300 && r <= 0x036F:
		return true
	case r >= 0x1AB0 && r <= 0x1AFF:
		return true
	case r >= 0x1DC0 && r <= 0x1DFF:
		return true
	case r >= 0x200B && r <= 0x200F:
		return true
	case r >= 0x202A && r <= 0x202E:
		return true
	case r >= 0x2060 && r <= 0x2064:
		return true
	case r >= 0x20D0 && r <= 0x20FF:
		return true
	case r >= 0xFE20 && r <= 0xFE2F:
		return true
	case r == 0xFEFF:
		return true
	}
	return false
}

// mapRune is contract step 2. Anything not listed is left alone (false means "no mapping").
func mapRune(r rune) (rune, bool) {
	switch {
	case r == 0x00A0:
		return 0x0020, true
	case r >= 0x2000 && r <= 0x200A:
		return 0x0020, true
	case r == 0x2028 || r == 0x2029 || r == 0x202F:
		return 0x0020, true
	case r == 0x205F || r == 0x3000:
		return 0x0020, true
	case r >= 0xFF01 && r <= 0xFF5E:
		return r - 0xFEE0, true
	case r == 0x2018 || r == 0x2019 || r == 0x201B || r == 0x2032:
		return '\'', true
	case r == 0x201C || r == 0x201D || r == 0x201F || r == 0x2033:
		return '"', true
	case r >= 0x2010 && r <= 0x2015:
		return '-', true
	case r == 0x2212:
		return '-', true
	case r == 0x3001:
		return ',', true
	case r == 0x3002:
		return '.', true
	}
	return r, false
}

// trimAndCollapseSpaces is contract steps 5 and 6 in one pass: every run of space, tab, LF or CR
// becomes a single space, and no space is written at the very start or the very end.
func trimAndCollapseSpaces(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	pendingSpace := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
			if b.Len() > 0 {
				pendingSpace = true
			}
			continue
		}
		if pendingSpace {
			b.WriteByte(' ')
			pendingSpace = false
		}
		b.WriteByte(c)
	}
	return b.String()
}
