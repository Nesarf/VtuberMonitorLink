package main

// extract.go implements docs/WORKERS.md section 3, capability text.extract.
//
// A specified state machine, not an HTML parser. In contract order:
//   1 script/style/noscript/template/svg/iframe are removed with their content; a missing closing
//     tag means "to end of input"
//   2 comments and <!DOCTYPE ...> declarations are removed; <![CDATA[ ... ]]> keeps its inner text
//   3 block-level tags become a newline on both the opening and the closing tag
//   4 every other tag is dropped and its text content stays; <a href="..."> produces a link entry
//     with the href verbatim and absolute = "starts with a scheme"
//   5 the first <title> outside a removed element is the title; its text is NOT part of `text`
//   6 entities are decoded
//   7 images counts <img tags whose name is exactly img
//   8 extract NEVER normalizes: the text keeps its newlines, the title and the link texts keep their
//     case and their accents. Normalization is a separate capability.
//
// "Tags" here means the contract's tags: `<` followed by [A-Za-z/!] and then, for a name, an
// optional '/', optional spaces, and [A-Za-z][A-Za-z0-9:-]*. The '<' of "<3" stays literal text.

import "strings"

// blockNewlineTags is exactly the list in contract step 3.
var blockNewlineTags = map[string]bool{
	"br": true, "p": true, "div": true, "li": true, "ul": true, "ol": true, "tr": true,
	"th": true, "td": true, "h1": true, "h2": true, "h3": true, "h4": true, "h5": true,
	"h6": true, "section": true, "article": true, "header": true, "footer": true,
	"aside": true, "nav": true, "blockquote": true, "pre": true, "table": true, "hr": true,
	"dd": true, "dt": true, "figure": true, "figcaption": true, "main": true, "form": true,
}

// removedWithContentTags is exactly the list in contract step 1, matched case-insensitively.
var removedWithContentTags = []string{"script", "style", "noscript", "template", "svg", "iframe"}

// linkEntry is one element of the output array "links". Field order is the order the contract lists
// them in ("href", "absolute", "text").
type linkEntry struct {
	Href     string `json:"href"`
	Absolute bool   `json:"absolute"`
	Text     string `json:"text"`
}

// extractOutput is the shape of the text.extract output object, fields in contract order.
type extractOutput struct {
	Title  string      `json:"title"`
	Text   string      `json:"text"`
	Links  []linkEntry `json:"links"`
	Images int         `json:"images"`
}

func extractHTML(html string, baseURL *string) extractOutput {
	// baseUrl is accepted and deliberately unused: contract step 4 keeps hrefs verbatim and states
	// that resolving URLs is out of scope for a text function.
	_ = baseURL

	src := html
	// CDATA bodies are lifted first and restored during the walk; comments and doctypes go next,
	// then the removed elements. CDATA before the comment rule, or a comment rule would eat the
	// inside of a CDATA section that happens to contain "-->".
	src, cdataBodies := liftCDATA(src)
	src = stripComments(src)
	src = stripDoctype(src)
	for _, tag := range removedWithContentTags {
		src = removeElement(src, tag)
	}
	return walkHTML(src, cdataBodies)
}

// ---------------------------------------------------------------------------
// Pass 1 and 2: CDATA, comments, doctypes, removed elements
// ---------------------------------------------------------------------------

const cdataOpen = "<![CDATA["
const cdataClose = "]]>"

// cdataMark is the placeholder that stands in for a lifted CDATA body. U+0001 is used because it can
// never be confused with markup (the tag pass only reacts to '<'), it cannot be produced by the
// other passes, and it is a code point the normalizer deletes, so a placeholder that somehow escaped
// could not silently reach a caller as garbage.
const cdataMark = '\x01'

// liftCDATA is the first pass. CDATA is CHARACTER DATA: its content is literal text that must not be
// re-parsed as markup, so "<![CDATA[<b>raw</b>]]>" keeps its tags. Lifting the body out *before* the
// comment and removed-element passes is what makes the two halves of the rule come out right:
//
//	lift first: a <script> inside a CDATA section is text                    -> it survives
//	lift first: a CDATA section inside a real removed element is removed with it -> removal wins
//
// The bodies come back during the walk, in order, so nothing outside them can consume them.
func liftCDATA(s string) (string, []string) {
	if !strings.Contains(s, cdataOpen) {
		return s, nil
	}
	var b strings.Builder
	b.Grow(len(s))
	var bodies []string
	for i := 0; i < len(s); {
		if !strings.HasPrefix(s[i:], cdataOpen) {
			b.WriteByte(s[i])
			i++
			continue
		}
		inner := i + len(cdataOpen)
		end := strings.Index(s[inner:], cdataClose)
		var body string
		if end < 0 {
			body = s[inner:] // an unclosed CDATA keeps everything to the end of input
			i = len(s)
		} else {
			body = s[inner : inner+end]
			i = inner + end + len(cdataClose)
		}
		b.WriteByte(cdataMark)
		bodies = append(bodies, body)
	}
	return b.String(), bodies
}

func stripComments(s string) string {
	for {
		start := strings.Index(s, "<!--")
		if start < 0 {
			return s
		}
		end := strings.Index(s[start+4:], "-->")
		if end < 0 {
			return s[:start] // an unterminated comment runs to end of input
		}
		s = s[:start] + s[start+4+end+3:]
	}
}

func stripDoctype(s string) string {
	for i := 0; i < len(s); {
		if s[i] == '<' && hasPrefixFold(s[i:], "<!doctype") {
			if end := strings.IndexByte(s[i:], '>'); end >= 0 {
				s = s[:i] + s[i+end+1:]
			} else {
				s = s[:i] // no '>': removed to end of input
			}
			continue
		}
		i++
	}
	return s
}

// removeElement removes every <tag ...> ... </tag ...> occurrence, content included. A missing
// closing tag means "to end of input".
func removeElement(s, tag string) string {
	open := "<" + tag
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); {
		if s[i] != '<' || !hasPrefixFold(s[i:], open) {
			b.WriteByte(s[i])
			i++
			continue
		}
		// The name must end at a word boundary: "<scripted>" is not a script element.
		boundary := i + len(open)
		if boundary < len(s) && isNameByte(s[boundary]) {
			b.WriteByte(s[i])
			i++
			continue
		}
		_, name, ok := scanTag(s, i)
		if !ok || name != tag {
			b.WriteByte(s[i])
			i++
			continue
		}
		// find the closing tag; anything before it is discarded
		close := "</" + tag
		end := len(s) // "to end of input" when the closing tag is missing
		for j := boundary; j < len(s); j++ {
			if s[j] == '<' && hasPrefixFold(s[j:], close) {
				after := j + len(close)
				if after < len(s) && isNameByte(s[after]) {
					continue // "</scripted>" is not the closing tag
				}
				c := after
				for c < len(s) && isSpaceByte(s[c]) {
					c++
				}
				if c < len(s) && s[c] == '>' {
					end = c + 1
				} else {
					end = after
				}
				break
			}
		}
		i = end
	}
	return b.String()
}

// ---------------------------------------------------------------------------
// Pass 3: one walk over the survivors
// ---------------------------------------------------------------------------

type anchorFrame struct {
	href    string
	hasHref bool
	text    strings.Builder
}

func walkHTML(src string, cdataBodies []string) extractOutput {
	var text strings.Builder
	var title strings.Builder
	links := make([]linkEntry, 0, 4)
	var pending *anchorFrame
	images := 0
	titleSeen := false
	inTitle := false
	cdataNext := 0 // index of the next lifted CDATA body to restore

	pushText := func(chunk string) {
		if chunk == "" {
			return
		}
		text.WriteString(chunk)
		if pending != nil {
			pending.text.WriteString(chunk)
		}
	}

	// pushCharData restores a lifted CDATA body. It is character data: routed to the body or the
	// title like any other text, and never re-parsed as markup.
	pushCharData := func(chunk string) {
		if chunk == "" {
			return
		}
		if inTitle {
			title.WriteString(chunk)
			return
		}
		text.WriteString(chunk)
	}

	for i := 0; i < len(src); {
		ch := src[i]
		if ch == cdataMark {
			// Restore the next lifted CDATA body, in order. The tag pass never sees its content.
			if cdataNext < len(cdataBodies) {
				pushCharData(cdataBodies[cdataNext])
				cdataNext++
			}
			i++
			continue
		}
		if ch == '<' && i+1 < len(src) && startsTag(src[i+1]) {
			end, name, _ := scanTag(src, i)
			raw := src[i+1 : end] // without the angle brackets; an unclosed tag has no '>'
			closed := end > i+1 && src[end-1] == '>'
			if closed {
				raw = src[i+1 : end-1]
			}
			i = end
			closing := strings.HasPrefix(raw, "/")
			// A tag that is never closed before end of input is dropped as a tag and contributes
			// nothing at all - not a newline either. "<p" at EOF is therefore not a paragraph.
			if !closed {
				continue
			}

			if name == "title" {
				if !closing && !titleSeen {
					inTitle = true
					titleSeen = true
				} else if closing && inTitle {
					inTitle = false
				}
				continue
			}
			if name == "img" && !closing {
				images++
				continue
			}
			if name == "a" {
				if !closing {
					// HTML does not allow nested anchors: a browser closes the open one and starts the
					// new one, so the outer is reported with the text it had collected up to here and
					// the inner becomes the open anchor. Ignoring the inner - and thereby dropping its
					// href - was a real divergence shared by every implementation until this worker
					// flagged it. A self-closing <a/> reports nothing and opens nothing.
					if pending != nil {
						links = append(links, pending.report())
						pending = nil
					}
					selfClosing := end > i && src[end-1] == '/' && src[end-2] != '<'
					if !selfClosing {
						href, ok := attributeValue(raw, "href")
						pending = &anchorFrame{href: href, hasHref: ok}
					}
				} else if pending != nil {
					links = append(links, pending.report())
					pending = nil
				}
				continue
			}
			if blockNewlineTags[name] {
				pushText("\n")
			}
			continue
		}
		if ch == '&' {
			if decoded, next, ok := decodeEntity(src, i); ok {
				// Entities are decoded before the title/body split, so a title decodes exactly like
				// the body text does.
				if inTitle {
					title.WriteString(decoded)
				} else {
					pushText(decoded)
				}
				i = next
				continue
			}
		}
		if inTitle {
			title.WriteByte(ch)
		} else {
			pushText(src[i : i+1])
		}
		i++
	}

	// An anchor still open at end of input is reported with the text it collected.
	if pending != nil {
		links = append(links, pending.report())
	}

	return extractOutput{
		Title:  title.String(),
		Text:   text.String(),
		Links:  links,
		Images: images,
	}
}

// report turns the anchor that is still open at end of input into its link entry: an unclosed <a>
// is reported with the text it collected, not dropped.
func (f *anchorFrame) report() linkEntry {
	return linkEntry{
		Href:     f.href,
		Absolute: hrefHasScheme(f.href),
		Text:     f.text.String(),
	}
}

func startsTag(c byte) bool {
	return c == '/' || c == '!' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
}

// scanTag inspects the '<' at index start and returns the index just past the tag, the lowercased
// tag name, whether this '<' starts a tag at all, and whether the tag was CLOSED by a '>' before end
// of input. The name is the contract's name: an optional '/', optional spaces, then
// [A-Za-z][A-Za-z0-9:-]*. A '>' inside a quoted attribute value does not end the tag.
//
// The closed flag is returned rather than inferred by the caller from "the tag text ends with '>'":
// that inference is wrong exactly when the input ends with a '>' that belongs to an inner quoted
// attribute value, as in `<p title="unclosed</div>`, where the final '>' is the div's own. An
// unclosed tag is dropped as a tag and contributes nothing, not even a block-tag newline.
func scanTag(s string, start int) (end int, name string, ok bool, closed bool) {
	if start+1 >= len(s) || s[start] != '<' || !startsTag(s[start+1]) {
		return start + 1, "", false, false
	}
	nameStart := start + 1
	if s[nameStart] == '/' {
		nameStart++
	}
	for nameStart < len(s) && isSpaceByte(s[nameStart]) {
		nameStart++
	}
	i := nameStart
	if i < len(s) && ((s[i] >= 'A' && s[i] <= 'Z') || (s[i] >= 'a' && s[i] <= 'z')) {
		i++
		for i < len(s) && isTagNameByte(s[i]) {
			i++
		}
	}
	name = strings.ToLower(s[nameStart:i])

	j := start + 1
	for j < len(s) {
		c := s[j]
		if c == '"' || c == '\'' {
			j++
			for j < len(s) && s[j] != c {
				j++
			}
			if j < len(s) {
				j++
			}
			continue
		}
		if c == '>' {
			return j + 1, name, true, true
		}
		j++
	}
	return len(s), name, true
}

func isNameByte(c byte) bool {
	return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
}

func isTagNameByte(c byte) bool {
	return isNameByte(c) || c == ':' || c == '-'
}

func isSpaceByte(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v'
}

// attributeValue returns an attribute's value from a tag's raw inner text (everything between the
// angle brackets). The value is verbatim: no entity decoding, no resolution. The attribute name
// must have a word boundary in front of it, so "data-href" does not answer for "href".
func attributeValue(raw, attr string) (string, bool) {
	for i := 0; i < len(raw); i++ {
		if !hasPrefixFold(raw[i:], attr) {
			continue
		}
		if i > 0 && isTagNameByte(raw[i-1]) {
			continue
		}
		j := i + len(attr)
		for j < len(raw) && isSpaceByte(raw[j]) {
			j++
		}
		if j >= len(raw) || raw[j] != '=' {
			continue
		}
		j++
		for j < len(raw) && isSpaceByte(raw[j]) {
			j++
		}
		if j >= len(raw) {
			return "", true
		}
		if raw[j] == '"' || raw[j] == '\'' {
			quote := raw[j]
			j++
			start := j
			for j < len(raw) && raw[j] != quote {
				j++
			}
			return raw[start:j], true
		}
		start := j
		for j < len(raw) && !isSpaceByte(raw[j]) && raw[j] != '>' {
			j++
		}
		return raw[start:j], true
	}
	return "", false
}

// hrefHasScheme is contract step 4: "starts with a scheme" - [A-Za-z][A-Za-z0-9+.-]*:. Nothing is
// resolved, and no URL is validated beyond that.
func hrefHasScheme(href string) bool {
	if href == "" {
		return false
	}
	c := href[0]
	if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z') {
		return false
	}
	for i := 1; i < len(href); i++ {
		c = href[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9':
		case c == '+' || c == '.' || c == '-':
		default:
			return c == ':'
		}
	}
	return false
}

func hasPrefixFold(s, prefix string) bool {
	if len(s) < len(prefix) {
		return false
	}
	for i := 0; i < len(prefix); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		if c != prefix[i] {
			return false
		}
	}
	return true
}

// ---------------------------------------------------------------------------
// Entities - contract step 6
// ---------------------------------------------------------------------------

// entityNameOrder lists the contract's named entities longest-first so that the longest name is the
// one that matches ("&laquo;" must not be read as "&laq"). The tables below are never iterated to
// build output; only this fixed order is walked.
var entityNameOrder = []string{
	"middot", "hellip", "mdash", "ndash", "times", "trade", "laquo", "raquo",
	"nbsp", "copy", "quot", "apos", "amp", "reg", "lt", "gt",
}

// namedEntities holds the decoded result of every name in entityNameOrder. These are the code
// points the names denote; contract step 7 then lets the normalizer's own rules handle a decoded
// value such as U+00A0.
var namedEntities = map[string]string{
	"amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'",
	"nbsp": "\u00A0", "mdash": "\u2014", "ndash": "\u2013", "hellip": "\u2026",
	"laquo": "\u00AB", "raquo": "\u00BB", "copy": "\u00A9", "reg": "\u00AE",
	"trade": "\u2122", "times": "\u00D7", "middot": "\u00B7",
}

// entityWindow is how far past the '&' a reference may end: the contract's longest form is "&#xHHHHHH;"
// or an eight-character name plus its semicolon, so 12 characters cover the whole closed set and pin
// the "no backtracking" rule ("&copy2024" stops being a reference at all).
const entityWindow = 12

// decodeEntity decodes the entity at i, which points at '&'. It returns the decoded text, the index
// just past it, and ok=false when there is no entity here (the '&' then stays literal).
//
// A named reference is recognised by the longest name of the closed set matching immediately after
// the '&'; a name that runs on into further name characters is not a reference, which is what makes
// "&copy2024" and "&ampersand" literal. A numeric reference is "&#" 1-7 decimal digits or "&#x"/
// "&#X" 1-6 hex digits; both forms decode with or without a trailing semicolon, as browsers do.
func decodeEntity(src string, i int) (string, int, bool) {
	if i+1 >= len(src) || src[i] != '&' {
		return "", i, false
	}
	if src[i+1] == '#' {
		return decodeNumericEntity(src, i)
	}
	limit := i + entityWindow
	if limit > len(src) {
		limit = len(src)
	}
	for _, name := range entityNameOrder {
		end := i + 1 + len(name)
		if end > limit || end > len(src) {
			continue
		}
		if !equalFoldASCII(src[i+1:end], name) {
			continue
		}
		if end < len(src) && isNameByte(src[end]) {
			return "", i, false // the name runs on: not a reference
		}
		next := end
		if next < len(src) && src[next] == ';' {
			next++
		}
		return namedEntities[name], next, true
	}
	return "", i, false
}

func decodeNumericEntity(src string, i int) (string, int, bool) {
	j := i + 2
	base := 10
	limit := 7
	if j < len(src) && (src[j] == 'x' || src[j] == 'X') {
		base = 16
		limit = 6
		j++
	}
	digits := 0
	value := 0
	for j < len(src) && digits < limit {
		d := digitValue(src[j], base)
		if d < 0 {
			break
		}
		if value <= 0x10FFFF {
			value = value*base + d
		}
		digits++
		j++
	}
	if digits == 0 {
		return "", i, false
	}
	if j < len(src) && src[j] == ';' {
		j++
	}
	// U+0000 is a legal scalar value and decodes to NUL; only a value outside the scalar range or a
	// surrogate half is refused (and then stays verbatim as part of an unknown entity).
	if value < 0 || value > 0x10FFFF {
		return "", i, false
	}
	if value >= 0xD800 && value <= 0xDFFF {
		return "", i, false // not a Unicode scalar value
	}
	return string(rune(value)), j, true
}

func digitValue(c byte, base int) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case base == 16 && c >= 'a' && c <= 'f':
		return int(c-'a') + 10
	case base == 16 && c >= 'A' && c <= 'F':
		return int(c-'A') + 10
	}
	return -1
}

// equalFoldASCII compares against a lowercase ASCII literal, folding the input side.
func equalFoldASCII(s, lower string) bool {
	if len(s) != len(lower) {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		if c != lower[i] {
			return false
		}
	}
	return true
}
