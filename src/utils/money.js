/*
  Money arithmetic in whole cents.

  Amounts are NUMERIC(12,2) in the database and arrive as text.
  Adding or subtracting them as JavaScript numbers leaves tiny
  remainders (1300 - 1234.56 - 65.44 is 0.00000000000006, not 0),
  which once made a whole payment fail. Every split of money is
  done in cents and turned back into a two-decimal amount only
  when written.
*/

// 1234.56 or "1234.56" -> 123456
function to_cents(value) {
  return Math.round(Number(value || 0) * 100);
}

// 123456 -> "1234.56", the form written to the database.
function from_cents(cents) {
  return (Math.round(cents) / 100).toFixed(2);
}

// 123456 -> 1234.56, the form returned in API answers.
function cents_to_number(cents) {
  return Math.round(cents) / 100;
}

// Rounds an amount to the cent: 0.1 + 0.2 -> 0.3.
function round_money(value) {
  return cents_to_number(to_cents(value));
}

// Adds amounts to the cent: [0.1, 0.2] -> 0.3.
function sum_money(values) {
  return cents_to_number(
    values.reduce((total, value) => total + to_cents(value), 0)
  );
}

/*
  A water bill: units used x the rate, rounded to the cent.
  Readings have three decimals, so they are counted in thousandths
  of a unit; 12.300 to 12.345 at 23 a unit is 1.035, billed 1.04
  (JavaScript's own sum gives 1.03).
*/
function water_bill(previous_reading, current_reading, rate_per_unit) {
  const thousandths =
    Math.round(Number(current_reading) * 1000) -
    Math.round(Number(previous_reading) * 1000);

  return cents_to_number(
    Math.round((thousandths * to_cents(rate_per_unit)) / 1000)
  );
}

// Units used between two readings, to three decimals.
function units_between(previous_reading, current_reading) {
  return (
    (Math.round(Number(current_reading) * 1000) -
      Math.round(Number(previous_reading) * 1000)) /
    1000
  );
}

module.exports = {
  to_cents,
  from_cents,
  cents_to_number,
  round_money,
  sum_money,
  water_bill,
  units_between,
};
