package main

// numbers.go - exact integer arithmetic for the numbers that arrive in a request.
//
// `now`, `lastRunAt` and `minIntervalMs` are epoch milliseconds, and `now - lastRunAt >= minIntervalMs`
// is the whole of the "is this source due" question. Three ways to get it wrong, all of them avoided
// here:
//
//   - a float64 (what encoding/json hands back for a bare `interface{}`) cannot hold every epoch
//     millisecond exactly, so the comparison would be approximate where the contract asks for an
//     exact answer;
//   - int64 arithmetic wraps: with `now` at the maximum int64 and a negative `lastRunAt`, the
//     subtraction overflows and turns a due source into a "not due" one;
//   - a value that is not an integer at all (1.5, 1e-2) is not a count and is bad input, but a value
//     written 500.0 or 1e2 *is* an integer and must be accepted as one.
//
// big.Rat parses a JSON number exactly and answers all three: SetString accepts plain, decimal and
// exponent forms; IsInt reports whether the value is a whole number; and the comparison is exact and
// unbounded, so no overflow is possible. This is integer arithmetic, not floating point: the contract
// forbids floats, and a rational whose denominator is always 1 is an integer.

import (
	"encoding/json"
	"math"
	"math/big"
	"strconv"
)

// exactInt is the contract's integer: a rational that is always a whole number.
type exactInt = big.Rat

// intOf reads a JSON number into an exact integer. ok is false when the value is not a whole number,
// including when it is not a JSON number at all or did not parse.
func intOf(v interface{}) (n *exactInt, ok bool) {
	number, isNumber := v.(json.Number)
	if !isNumber {
		return nil, false
	}
	r := new(big.Rat)
	if _, parsed := r.SetString(string(number)); !parsed {
		return nil, false
	}
	if !r.IsInt() {
		return nil, false
	}
	return r, true
}

// isCount reports whether a JSON value is a non-negative integer: the shape the contract uses for
// every limit and every interval, and the rule that makes a negative limit bad input.
func isCount(v interface{}) bool {
	n, ok := intOf(v)
	return ok && n.Sign() >= 0
}

// atLeast reports whether a >= b for two exact integers.
func atLeast(a, b *exactInt) bool { return a.Cmp(b) >= 0 }

// exactIntOf returns the exact integer n.
func exactIntOf(n int) *exactInt { return new(exactInt).SetInt64(int64(n)) }

// subtract returns a - b, exactly and without an upper bound: int64 arithmetic would wrap here for
// timestamps at the edge of the range, and a wrapped difference reports a due source as too early.
func subtract(a, b *exactInt) *exactInt { return new(exactInt).Sub(a, b) }

// clampToInt turns an exact integer into an int without losing a comparison. A limit larger than the
// largest int (budget.maxRequests: 1e30, say) must behave as "no limit within this plan" rather than
// wrapping to a negative capacity, which would defer every source in the plan.
func clampToInt(n *exactInt) int {
	if !n.IsInt() {
		return 0
	}
	num := n.Num()
	if num.IsInt64() {
		value := num.Int64()
		if value > int64(math.MaxInt) {
			return math.MaxInt
		}
		if value < int64(math.MinInt) {
			return math.MinInt
		}
		return int(value)
	}
	if n.Sign() < 0 {
		return math.MinInt
	}
	return math.MaxInt
}

// itoa is strconv.Itoa behind a local name, so the planning file reads as prose about sources.
func itoa(n int) string { return strconv.Itoa(n) }
