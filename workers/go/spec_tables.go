package main

// spec_tables.go loads the shared case/fold tables that docs/WORKERS.md section 2 names as the
// rule: workers/spec/latin-lower.json and workers/spec/latin-fold.json.
//
// The tables are read at RUN TIME from workers/spec/ (see README.md -> "Strategy"). The strings of
// the spec files are ASCII in both files (latin-fold.json is all ASCII; latin-lower.json has no
// string values at all), so decoding them with encoding/json cannot introduce a chcp/GBK problem.
//
// stdlib only: encoding/json, fmt, os, path/filepath, runtime, strings.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// lowerEntry: target is always a single code point (the contract: "one code point to one code point").
type lowerEntry struct {
	target rune
}

// foldEntry: target is an ASCII string of one or two bytes (the contract: "an ASCII string of one
// or two characters"). Kept as a []byte so appending it to the output cannot re-encode anything.
type foldEntry struct {
	target []byte
}

// textTables is the whole shared-table state. Nothing else in the program consults a Unicode table:
// the Go standard library is not asked to lowercase, fold or normalize anything.
//
// The tables are dense slices indexed by code point, not maps: a map would be fine for correctness
// but a slice keeps the hot loop branch-free and, more importantly, keeps map iteration out of the
// program entirely. The contract's tables cover U+0000-U+024F (the shipped files top out at U+0236
// and U+024E keys), and a slice grown to the largest key in the file also survives a regenerated
// table that adds a key the contract's domain note did not mention.
type textTables struct {
	lower []*lowerEntry
	fold  []*foldEntry
}

var tables *textTables

type specTableFile struct {
	Map map[string]json.RawMessage `json:"map"`
}

// LoadTables reads both spec files. The directory is resolved by searchRepoSpec():
// next to the executable first, then walking up from the working directory.
func LoadTables() (*textTables, error) {
	dir, err := searchRepoSpec()
	if err != nil {
		return nil, err
	}
	lower, err := loadLowerTable(filepath.Join(dir, "latin-lower.json"))
	if err != nil {
		return nil, err
	}
	fold, err := loadFoldTable(filepath.Join(dir, "latin-fold.json"))
	if err != nil {
		return nil, err
	}
	t := &textTables{}
	if err := t.fill(lower, fold); err != nil {
		return nil, err
	}
	return t, nil
}

func loadLowerTable(path string) ([]struct {
	from int
	to   int
}, error) {
	raw, err := readSpecFile(path)
	if err != nil {
		return nil, err
	}
	var file specTableFile
	if err := json.Unmarshal(raw, &file); err != nil {
		return nil, fmt.Errorf("%s: not valid JSON: %v", path, err)
	}
	if file.Map == nil {
		return nil, fmt.Errorf("%s: no \"map\" object", path)
	}
	// Sorted output: Go map iteration order is randomised, and a table built in a random order would
	// not be observable in the output, but the duplicate check below must report a stable first
	// offender, so keys are sorted explicitly rather than iterated.
	keys := sortedJSONKeys(file.Map)
	out := make([]struct {
		from int
		to   int
	}, 0, len(keys))
	for _, key := range keys {
		from, err := parseDecimalKey(path, key)
		if err != nil {
			return nil, err
		}
		var to int
		if err := json.Unmarshal(file.Map[key], &to); err != nil {
			return nil, fmt.Errorf("%s: value for key %q is not an integer", path, key)
		}
		out = append(out, struct {
			from int
			to   int
		}{from, to})
	}
	return out, nil
}

func loadFoldTable(path string) ([]struct {
	from int
	to   string
}, error) {
	raw, err := readSpecFile(path)
	if err != nil {
		return nil, err
	}
	var file specTableFile
	if err := json.Unmarshal(raw, &file); err != nil {
		return nil, fmt.Errorf("%s: not valid JSON: %v", path, err)
	}
	if file.Map == nil {
		return nil, fmt.Errorf("%s: no \"map\" object", path)
	}
	keys := sortedJSONKeys(file.Map)
	out := make([]struct {
		from int
		to   string
	}, 0, len(keys))
	for _, key := range keys {
		from, err := parseDecimalKey(path, key)
		if err != nil {
			return nil, err
		}
		var to string
		if err := json.Unmarshal(file.Map[key], &to); err != nil {
			return nil, fmt.Errorf("%s: value for key %q is not a string", path, key)
		}
		out = append(out, struct {
			from int
			to   string
		}{from, to})
	}
	return out, nil
}

func readSpecFile(path string) ([]byte, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("cannot read the shared table %s: %v", path, err)
	}
	if len(raw) >= 3 && raw[0] == 0xEF && raw[1] == 0xBB && raw[2] == 0xBF {
		raw = raw[3:] // tolerate a BOM
	}
	return raw, nil
}

func parseDecimalKey(path, key string) (int, error) {
	if key == "" {
		return 0, fmt.Errorf("%s: empty table key", path)
	}
	value := 0
	for i := 0; i < len(key); i++ {
		if key[i] < '0' || key[i] > '9' {
			return 0, fmt.Errorf("%s: table key %q is not a decimal code point", path, key)
		}
		value = value*10 + int(key[i]-'0')
		if value > 0x10FFFF {
			return 0, fmt.Errorf("%s: table key %q is out of range", path, key)
		}
	}
	return value, nil
}

// sortedJSONKeys returns the keys of the decoded "map" object in ascending order, without letting
// an unsorted map iteration escape (the determinism rule of the contract).
func sortedJSONKeys(m map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	return keys
}

// fill copies the two spec tables into slices indexed by code point. The contract's table domain is
// U+0000-U+024F; a key outside it is refused rather than silently truncated, because a table the
// contract does not describe would change the normalize output without anyone noticing.
func (t *textTables) fill(lower []struct {
	from int
	to   int
}, fold []struct {
	from int
	to   string
}) error {
	const domainMax = 0x024F

	lowerMax := 0
	for _, entry := range lower {
		if entry.from < 0 || entry.from > domainMax {
			return fmt.Errorf("latin-lower.json: key %d is outside the contract domain U+0000-U+024F", entry.from)
		}
		if entry.from == 0x0130 {
			return fmt.Errorf("latin-lower.json: U+0130 is present, but the contract says it is deliberately absent")
		}
		if entry.from > lowerMax {
			lowerMax = entry.from
		}
	}
	t.lower = make([]*lowerEntry, lowerMax+1)
	for _, entry := range lower {
		if t.lower[entry.from] != nil {
			return fmt.Errorf("latin-lower.json: duplicate key %d", entry.from)
		}
		t.lower[entry.from] = &lowerEntry{target: rune(entry.to)}
	}

	foldMax := 0
	for _, entry := range fold {
		if entry.from < 0 || entry.from > domainMax {
			return fmt.Errorf("latin-fold.json: key %d is outside the contract domain U+0000-U+024F", entry.from)
		}
		if entry.to == "" {
			return fmt.Errorf("latin-fold.json: key %d folds to the empty string", entry.from)
		}
		for i := 0; i < len(entry.to); i++ {
			if entry.to[i] > 0x7F {
				return fmt.Errorf("latin-fold.json: key %d folds to a non-ASCII string", entry.from)
			}
		}
		if entry.from > foldMax {
			foldMax = entry.from
		}
	}
	t.fold = make([]*foldEntry, foldMax+1)
	for _, entry := range fold {
		if t.fold[entry.from] != nil {
			return fmt.Errorf("latin-fold.json: duplicate key %d", entry.from)
		}
		t.fold[entry.from] = &foldEntry{target: []byte(entry.to)}
	}
	return nil
}

// searchRepoSpec returns the directory holding the shared spec tables.
//
// Order: <exe dir>/spec, then <exe dir>/../../spec (= workers/go/dist/../.. = workers/spec), then
// every ancestor of the working directory looking for workers/spec. The walk covers both the
// contract's launch form ("workers/go/dist/vmltext.exe --capability <name>", run from the
// repository root) and a direct run from inside workers/go.
func searchRepoSpec() (string, error) {
	var tried []string
	consider := func(dir string) string {
		if dir == "" {
			return ""
		}
		cleaned := filepath.Clean(dir)
		candidate := filepath.Join(cleaned, "spec")
		if hasBothTables(candidate) {
			return candidate
		}
		tried = append(tried, candidate)
		return ""
	}

	if exe, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exe)
		if found := consider(exeDir); found != "" {
			return found, nil
		}
		if found := consider(filepath.Join(exeDir, "..", "..")); found != "" {
			return found, nil
		}
	}
	if cwd, err := os.Getwd(); err == nil {
		for dir := cwd; ; {
			if found := consider(dir); found != "" {
				return found, nil
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return "", fmt.Errorf("cannot find the shared tables (latin-lower.json, latin-fold.json); tried: %s",
		strings.Join(tried, ", "))
}

func hasBothTables(dir string) bool {
	for _, name := range []string{"latin-lower.json", "latin-fold.json"} {
		info, err := os.Stat(filepath.Join(dir, name))
		if err != nil || info.IsDir() {
			return false
		}
	}
	return true
}

func goRuntimeVersion() string {
	return runtime.Version()
}
