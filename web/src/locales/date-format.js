// locales/date-format.js — the one place that decides which calendar a date is shown in.
//
// `Intl.DateTimeFormat('th-TH')` resolves to the **Buddhist** calendar, so every timestamp this
// application formatted read 2569 while the calendar grid above it read 2026-09: the grid is built on
// the server from a Gregorian year and month and filled with the day numbers of a Gregorian month,
// while the timestamps went through Intl and picked up the Thai era. Two elements of one page
// disagreed about the year by 543 (docs/BUGS.md #79).
//
// The calendar is therefore pinned to Gregorian, for every locale, in this one place:
//
//   * the **data** is Gregorian everywhere - the grid is a Gregorian month, an entry's date is stored as
//     the ISO `YYYY-MM-DD` the user typed into a Gregorian field, an audit line's `at` and a report's
//     `mtime` are Gregorian instants, and a YouTube timestamp is Gregorian. A Buddhist or Hijri label
//     over a Gregorian grid is a label that lies about its own cells;
//   * what belongs to the locale is the **order**, the month and weekday names, the digits and the time
//     format, and those still come from Intl: `ar-SA` keeps its Arabic-Indic digits and `th-TH` keeps
//     `14 ก.ย.` - it is the year that stops being 2569;
//   * "which calendar is the default" is an ICU/CLDR question rather than a property of this
//     application. Measured on this machine, `th-TH` resolves to `buddhist` and `ar-SA` to `gregory`;
//     another browser or another ICU version is free to answer either of those differently. Pinning
//     makes the answer the same everywhere, which is what a date that has to line up with a source
//     timestamp needs.
//
// A caller may still pass its own `calendar` in `opts` - this is a default, not a cage.
export const CALENDAR = { calendar: 'gregory' };

/** Every date and time the UI shows goes through this, so there is exactly one calendar decision. */
export const dateFormat = (code, opts) => new Intl.DateTimeFormat(code, { ...CALENDAR, ...(opts ?? {}) });

/**
 * The month label over the calendar grid, e.g. `2026-09`.
 *
 * ISO on purpose, and deliberately not Intl's month-name formatting: the cells under it are a Gregorian
 * month's day numbers, and the entry rows beside it show the ISO date the store holds (`2026-09-14`). A
 * locale-ordered label (`09/2026`, or a locale's own month name) would be prettier and would say
 * something different from everything surrounding it, which is the mistake this file exists to prevent.
 */
export const monthLabel = (year, month) => `${year}-${String(month).padStart(2, '0')}`;
