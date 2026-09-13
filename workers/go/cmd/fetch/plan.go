package main

// plan.go - capability `fetch.plan`, docs/WORKERS.md section 10.
//
// The planning half of fetching: which sources go out this round, on which egress, in what order, and
// what waits. Nothing is fetched, nothing is written: the capability is arithmetic over the caller's
// input, which is what makes it comparable across languages at all. No clock is read (`now` is an
// input), no randomness, no floating point, and every list in the output has a specified order.
//
// The rules, in the order the contract applies them:
//
//  1. Egress must exist. A source whose `egress` is not a key of the input's `egress` object is
//     SKIPPED (`no-egress`) whatever the clock says: a broken egress name is a configuration the user
//     has to fix, not a source that is merely early. This is checked FIRST, before due-ness, on
//     purpose - and the corpus case `unknown-egress-is-skipped-even-when-not-due` pins it.
//  2. Due. A source is due when `due` is true, when `lastRunAt` is null (never run), or when
//     `now - lastRunAt >= minIntervalMs` with a missing `minIntervalMs` read as 0. Not due means
//     DEFERRED (`interval`). `lastRunAt: 0` is the epoch, a legitimate timestamp: reading it as
//     "never run" with a falsy test is the mistake this rule exists to prevent, so the value is kept
//     as an exact integer and compared with the clock, never treated as absent.
//  3. Order. Within one egress, due sources are ordered by `lastRunAt` ascending with null first,
//     then by `id` compared as UTF-8 bytes. null first is "waited longest"; the id comparison is Go's
//     own string comparison, which is byte order by definition - not `strings.Collate`, not a locale,
//     and not UTF-16 code units (UTF-16 order would put an astral id before U+FFFD, where byte order
//     puts it after).
//  4. Batches. One batch per egress, at most `maxConcurrent` sources (missing means 1, below 1 is bad
//     input), egresses emitted in ascending UTF-8 byte order of their names. An egress with no due
//     source gets no batch at all, and no map is ever iterated to produce the order: the names are
//     collected into a slice and sorted, so the answer does not depend on Go's map iteration order.
//  5. Budget. `budget.maxPerEgress` first, then `budget.maxRequests`, both caps applied to the same
//     batch: a due source that does not fit is DEFERRED (`budget`). A missing budget field is no
//     limit, a budget of 0 plans nothing. Because egresses are visited in name order, a shared budget
//     is spent in that order - which is why rule 4's order is part of the contract.
//  6. Counts and list order. `counts.planned` is the number of sources across all batches; both
//     report lists are emitted sorted by `id` as UTF-8 bytes, so two languages can be compared as
//     reports and not only as sets.
//
// Shapes are validated before the planning starts, in the order the contract lists them, and a
// violation is `bad-input` (an answer, not a crash). Source ids are assumed unique: duplicates are
// neither merged nor rejected, exactly as the contract says.

import (
	"errors"
	"sort"
)

// planOutput is the shape of the fetch.plan answer, fields in contract order.
type planOutput struct {
	Batches  []batchRow
	Deferred []reasonRow
	Skipped  []reasonRow
	Counts   planCounts
}

type batchRow struct {
	Egress  string
	Sources []string
}

type reasonRow struct {
	ID     string
	Reason string
}

type planCounts struct {
	Planned  int
	Deferred int
	Skipped  int
}

// The closed set of deferral and skip reasons. "Skipped means this source cannot be planned at all;
// deferred means not this round", and the reason is what the application shows a user.
const (
	reasonNoEgress = "no-egress"
	reasonInterval = "interval"
	reasonBudget   = "budget"
)

// dueSource is one source that passed rules 1 and 2 and is waiting for a lane.
type dueSource struct {
	id        string
	lastRunAt *exactInt
}

// plan implements the capability. Every error returned is a bad-input error: the contract's only
// other answer is a plan.
func plan(value interface{}) (planOutput, error) {
	// Shape first: the input must be an object, and the two required members must be there.
	field, err := objectValue(value)
	if err != nil {
		return planOutput{}, badInput("input must be a JSON object")
	}

	sourcesValue, present := field("sources")
	if !present {
		return planOutput{}, badInput("input.sources must be an array")
	}
	sourceList, isArray := sourcesValue.([]interface{})
	if !isArray {
		return planOutput{}, badInput("input.sources must be an array")
	}

	nowValue, present := field("now")
	if !present {
		return planOutput{}, badInput("input.now must be an integer")
	}
	now, isInteger := intOf(nowValue)
	if !isInteger {
		return planOutput{}, badInput("input.now must be an integer")
	}

	// Optional members are shape-checked here and used later: egress entries validate their
	// `maxConcurrent` when a source first points at them, and the budget is validated up front so
	// that a malformed cap is reported whether or not any source would reach it.
	egressValue, _ := field("egress")
	egress, err := objectValue(egressValue)
	if err != nil {
		// Absent, null or wrong shape: there is no egress to reach. A source that names one of the
		// keys it might have had is skipped as `no-egress` below, which is the honest answer.
		egress = nothing()
	}

	budgetValue, _ := field("budget")
	budget, _ := objectValue(budgetValue)

	// `budget.maxRequests`: absent or null means no limit, and 0 is a limit that plans nothing, so
	// the two cannot be represented by the same value.
	var maxRequests *exactInt
	if budget != nil {
		if raw, ok := budget("maxRequests"); ok && raw != nil {
			if !isCount(raw) {
				return planOutput{}, badInput("budget.maxRequests must be a non-negative integer")
			}
			limit, _ := intOf(raw)
			maxRequests = limit
		}
	}

	// `budget.maxPerEgress`: the whole object is validated before any planning, so a bad cap is
	// reported even when the egress it names has nothing due. A cap for an egress that does not exist
	// is not an error - rule 1 never asks about it.
	maxPerEgress := map[string]*exactInt{}
	if budget != nil {
		if raw, ok := budget("maxPerEgress"); ok {
			perEgress, isObject := raw.(map[string]interface{})
			if isObject {
				for _, name := range sortedKeys(perEgress) {
					if !isCount(perEgress[name]) {
						return planOutput{}, badInput("budget.maxPerEgress." + name + " must be a non-negative integer")
					}
					maxPerEgress[name], _ = intOf(perEgress[name])
				}
			}
		}
	}

	skipped := []reasonRow{}
	deferred := []reasonRow{}
	dueByEgress := map[string][]dueSource{}
	capacityOf := map[string]int{}

	for index, raw := range sourceList {
		source, isObject := raw.(map[string]interface{})
		if !isObject {
			return planOutput{}, badInput(sourceLabel(index) + ": a source must be an object")
		}

		idValue, _ := source["id"]
		id, isString := idValue.(string)
		if !isString || id == "" {
			return planOutput{}, badInput("every source needs a non-empty string id")
		}

		// Rule 1, before the clock: an egress that does not exist is not a matter of timing.
		egressValue, _ := source["egress"]
		egressName, isEgressName := egressValue.(string)
		if !isEgressName {
			return planOutput{}, badInput("source " + id + ": egress must be a string")
		}
		egressConfig, known := egress(egressName)
		if !known {
			skipped = append(skipped, reasonRow{ID: id, Reason: reasonNoEgress})
			continue
		}
		if _, already := capacityOf[egressName]; !already {
			// An egress entry may carry `maxConcurrent`; anything that is not an object carries none,
			// and the default is one lane.
			maxConcurrent := 1
			if config, isObject := egressConfig.(map[string]interface{}); isObject {
				if raw, ok := config["maxConcurrent"]; ok && raw != nil {
					count, isCountValue := intOf(raw)
					if !isCountValue || count.Sign() < 1 {
						return planOutput{}, badInput("egress " + egressName + ": maxConcurrent must be a positive integer")
					}
					// A lane count far beyond the number of sources is the same as no limit, so the
					// clamped value is the honest one: no arithmetic below depends on the difference.
					maxConcurrent = clampToInt(count)
				}
			}
			capacityOf[egressName] = maxConcurrent
		}

		// `lastRunAt`: a number, or null for "never run". A missing member is null as well, and only
		// the exact value 0 is the epoch. `due` is a separate, optional flag.
		var lastRunAt *exactInt
		if raw, ok := source["lastRunAt"]; ok && raw != nil {
			last, isInteger := intOf(raw)
			if !isInteger {
				return planOutput{}, badInput("source " + id + ": lastRunAt must be an integer or null")
			}
			lastRunAt = last
		}

		minIntervalMs := exactIntOf(0) // a missing interval is zero
		if raw, ok := source["minIntervalMs"]; ok && raw != nil {
			if !isCount(raw) {
				return planOutput{}, badInput("source " + id + ": minIntervalMs must be a non-negative integer")
			}
			minIntervalMs, _ = intOf(raw)
		}

		// Rule 2. `lastRunAt: 0` is a timestamp, not an absence: it reaches the comparison below and
		// is deferred when the interval has not passed.
		due := explicitlyDue(source)
		if !due {
			if lastRunAt == nil {
				due = true // never run: automatically due
			} else {
				due = atLeast(subtract(now, lastRunAt), minIntervalMs)
			}
		}
		if !due {
			deferred = append(deferred, reasonRow{ID: id, Reason: reasonInterval})
			continue
		}

		dueByEgress[egressName] = append(dueByEgress[egressName], dueSource{id: id, lastRunAt: lastRunAt})
	}

	// Rule 4. The egress names are collected and sorted by bytes: Go's map iteration order is
	// deliberately randomised, and letting it decide the order of the batches - or the order a shared
	// budget is spent in - would make the answer unreproducible within a single language.
	names := make([]string, 0, len(dueByEgress))
	for name := range dueByEgress {
		names = append(names, name)
	}
	sort.Strings(names)

	batches := []batchRow{}
	remaining := maxRequests // nil means no limit

	for _, name := range names {
		list := dueByEgress[name]
		// Rule 3: longest-waiting first, never-run sources before every timestamp, ties by id bytes.
		sort.SliceStable(list, func(i, j int) bool {
			left, right := list[i], list[j]
			if (left.lastRunAt == nil) != (right.lastRunAt == nil) {
				return left.lastRunAt == nil
			}
			if left.lastRunAt != nil && left.lastRunAt.Cmp(right.lastRunAt) != 0 {
				return left.lastRunAt.Cmp(right.lastRunAt) < 0
			}
			return left.id < right.id
		})

		// Rule 5: this egress's concurrency, capped by its own budget, then by what is left of the
		// shared one. The cap is applied here rather than by trimming the plan afterwards, so the
		// sources that do not fit are deferred by the same rule that deferred the too-early ones.
		capacity := capacityOf[name]
		if perEgress, ok := maxPerEgress[name]; ok {
			capacity = min(capacity, clampToInt(perEgress))
		}
		if remaining != nil {
			capacity = min(capacity, clampToInt(remaining))
		}

		take := 0
		if capacity > 0 {
			take = min(capacity, len(list))
		}
		for _, source := range list[take:] {
			deferred = append(deferred, reasonRow{ID: source.id, Reason: reasonBudget})
		}
		if take > 0 {
			taken := make([]string, 0, take)
			for _, source := range list[:take] {
				taken = append(taken, source.id)
			}
			batches = append(batches, batchRow{Egress: name, Sources: taken})
			if remaining != nil {
				remaining = subtract(remaining, exactIntOf(take))
			}
		}
	}

	// Rule 6: both lists are reports, so their order is part of the answer.
	sort.SliceStable(skipped, func(i, j int) bool { return skipped[i].ID < skipped[j].ID })
	sort.SliceStable(deferred, func(i, j int) bool { return deferred[i].ID < deferred[j].ID })

	planned := 0
	for _, batch := range batches {
		planned += len(batch.Sources)
	}
	return planOutput{
		Batches:  batches,
		Deferred: deferred,
		Skipped:  skipped,
		Counts:   planCounts{Planned: planned, Deferred: len(deferred), Skipped: len(skipped)},
	}, nil
}

// nothing is the lookup function of an object that has no members: `egress: {}` is the same as no
// egress at all as far as rule 1 is concerned, and every source is then skipped.
func nothing() func(key string) (interface{}, bool) {
	return func(string) (interface{}, bool) { return nil, false }
}

// sortedKeys returns an object's keys in ascending UTF-8 byte order. Map keys are only ever read
// through this, never ranged over, so no Go map iteration order can reach the output - including in
// the error message that names a bad `budget.maxPerEgress` entry, which must not depend on the map
// either.
func sortedKeys(object map[string]interface{}) []string {
	keys := make([]string, 0, len(object))
	for key := range object {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// sourceLabel names a source by position, for the sources whose own id is missing or of the wrong
// type and which therefore cannot be named by id.
func sourceLabel(index int) string {
	return "input.sources[" + itoa(index) + "]"
}

// badInput marks an error the host must see as code `bad-input` rather than `internal`.
func badInput(message string) error {
	return &badInputError{message: message}
}

type badInputError struct {
	message string
}

func (e *badInputError) Error() string { return e.message }

// isBadInput reports whether an error is the capability rejecting the input rather than failing.
func isBadInput(err error) bool {
	var bad *badInputError
	return errors.As(err, &bad)
}
