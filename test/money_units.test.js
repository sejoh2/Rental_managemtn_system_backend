// Money arithmetic and M-Pesa times, without a database.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  to_cents,
  from_cents,
  sum_money,
  water_bill,
  units_between,
} = require("../src/utils/money");

const {
  parse_trans_time,
  mpesa_paid_at,
} = require("../src/payments/mpesa/mpesa_time");

test("splitting 1,300 over 1,234.56 and 65.44 leaves exactly nothing", () => {
  // As plain numbers this leaves 0.00000000000006, which once failed the payment.
  assert.notEqual(1300 - 1234.56 - 65.44, 0);
  assert.equal(to_cents(1300) - to_cents("1234.56") - to_cents("65.44"), 0);
});

test("150.15 + 256.01 is exactly 406.16", () => {
  assert.equal(from_cents(to_cents("150.15") + to_cents("256.01")), "406.16");
  assert.equal(sum_money(["150.15", "256.01"]), 406.16);
});

test("water bills are rounded to the nearest cent", () => {
  // 12.300 to 12.345 at 23 a unit is 1.035: 1.04 (plain JavaScript gives 1.03).
  assert.equal(water_bill("12.300", "12.345", "23"), 1.04);
  assert.equal(water_bill("1000.000", "1010.005", "101"), 1010.51);
  assert.equal(water_bill("100", "100.005", "15"), 0.08);
  assert.equal(water_bill("0", "12", "150"), 1800);
  assert.equal(units_between("12.300", "12.345"), 0.045);
});

test("an M-Pesa time is read as Kenyan time", () => {
  const paid = parse_trans_time("20261031235840");
  assert.equal(paid.toISOString(), "2026-10-31T20:58:40.000Z");
  assert.equal(parse_trans_time("20260231120000"), null);
  assert.equal(parse_trans_time("2026-10-31"), null);
  assert.equal(parse_trans_time(""), null);
});

test("a payment at 23:58 keeps its day when the notice comes after midnight", () => {
  const notice = new Date("2026-10-31T21:00:05.000Z"); // 1 Nov 00:00:05 in Nairobi
  const paid = mpesa_paid_at("20261031235840", notice);
  assert.equal(paid.toISOString(), "2026-10-31T20:58:40.000Z");
});

test("an M-Pesa time that cannot be right falls back to the arrival time", () => {
  const now = new Date("2026-10-29T09:00:00.000Z");
  assert.equal(mpesa_paid_at("20261231120000", now), now); // in the future
  assert.equal(mpesa_paid_at("20250101120000", now), now); // far too old
  assert.equal(mpesa_paid_at(undefined, now), now);
});
