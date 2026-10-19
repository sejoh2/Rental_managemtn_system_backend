/*
  Nairobi days as "YYYY-MM-DD" text. Nairobi is UTC+3 all year,
  so a day is never moved by a time zone. The database gives
  DATE columns back as text (::TEXT) for the same reason.
*/
const DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Nairobi",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const HOUR = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Nairobi",
  hour: "2-digit",
  hourCycle: "h23",
});

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const today = (now = new Date()) => DAY.format(now);
const nairobi_hour = (now = new Date()) => Number(HOUR.format(now));

function parts(day) {
  const [year, month, date] = String(day).slice(0, 10).split("-").map(Number);

  return { year, month, date };
}

const pad = (number) => String(number).padStart(2, "0");
const make = (year, month, date) => `${year}-${pad(month)}-${pad(date)}`;

function to_number(day) {
  const { year, month, date } = parts(day);

  return Date.UTC(year, month - 1, date) / 86400000;
}

function from_number(number) {
  const moment = new Date(number * 86400000);

  return make(moment.getUTCFullYear(), moment.getUTCMonth() + 1, moment.getUTCDate());
}

const add_days = (day, days) => from_number(to_number(day) + days);
const days_between = (from, to) => to_number(to) - to_number(from);

// The last day of the month `months` after the month of `day` (0: its own month).
function month_end(day, months = 0) {
  const { year, month } = parts(day);
  const last = new Date(Date.UTC(year, month - 1 + months + 1, 0));

  return make(last.getUTCFullYear(), last.getUTCMonth() + 1, last.getUTCDate());
}

function month_start(day) {
  const { year, month } = parts(day);

  return make(year, month, 1);
}

// The trial: until the end of the next full calendar month.
const trial_end_for = (start_day) => month_end(start_day, 1);

// "2026-12-01" -> "1 December 2026"
function label(day) {
  if (!day) return "-";

  const { year, month, date } = parts(day);

  return `${date} ${MONTHS[month - 1]} ${year}`;
}

// A bill's months: "December 2026", or "December 2026 to May 2027".
function period_label(start, end) {
  const a = parts(start);
  const b = parts(end);
  const first = `${MONTHS[a.month - 1]} ${a.year}`;
  const last = `${MONTHS[b.month - 1]} ${b.year}`;

  return first === last ? first : `${first} to ${last}`;
}

const later = (a, b) => (!a ? b : !b ? a : a > b ? a : b);

module.exports = {
  today,
  nairobi_hour,
  add_days,
  days_between,
  month_end,
  month_start,
  trial_end_for,
  label,
  period_label,
  later,
};
