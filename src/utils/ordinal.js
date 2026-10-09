/*
  5 -> "5th", 21 -> "21st".
  Used wherever a rent due day is shown in words.
*/
function ordinal_day(day) {
  const value = Number(day);

  if (!Number.isInteger(value) || value < 1) {
    return "";
  }

  const last_two = value % 100;

  if (last_two >= 11 && last_two <= 13) {
    return `${value}th`;
  }

  const suffix =
    { 1: "st", 2: "nd", 3: "rd" }[value % 10] || "th";

  return `${value}${suffix}`;
}

module.exports = {
  ordinal_day,
};
