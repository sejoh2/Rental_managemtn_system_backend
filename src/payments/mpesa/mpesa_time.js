/*
  When the tenant paid, from M-Pesa's TransTime.

  Safaricom sends TransTime as YYYYMMDDHHmmss in Kenyan time
  (East Africa Time, UTC+3, no daylight saving). The notice can
  reach Kodi seconds or, after a retry, much later, so the
  payment's date is taken from this and not from when the notice
  arrived.

  A value that is missing, malformed, in the future (beyond a few
  minutes of clock difference) or more than 60 days old is not
  trusted, and the time the notice arrived is used instead.
*/

const NAIROBI_OFFSET_MS = 3 * 60 * 60 * 1000;
const FUTURE_ALLOWANCE_MS = 10 * 60 * 1000;
const OLDEST_MS = 60 * 24 * 60 * 60 * 1000;

function parse_trans_time(value) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(
    String(value || "").trim()
  );

  if (!match) {
    return null;
  }

  const [year, month, day, hour, minute, second] = match
    .slice(1)
    .map(Number);

  const utc_ms =
    Date.UTC(year, month - 1, day, hour, minute, second) -
    NAIROBI_OFFSET_MS;

  const date = new Date(utc_ms);

  /*
    Date.UTC rolls 31 February over into March; a real time
    reads back the same.
  */
  const check = new Date(utc_ms + NAIROBI_OFFSET_MS);

  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute
  ) {
    return null;
  }

  return date;
}

// The time to record for a payment notice that arrives now.
function mpesa_paid_at(trans_time, now = new Date()) {
  const paid = parse_trans_time(trans_time);

  if (
    !paid ||
    paid.getTime() > now.getTime() + FUTURE_ALLOWANCE_MS ||
    paid.getTime() < now.getTime() - OLDEST_MS
  ) {
    return now;
  }

  return paid;
}

module.exports = {
  parse_trans_time,
  mpesa_paid_at,
};
