const {
  ordinal_day,
} = require("../utils/ordinal");

const default_template_content = `TENANCY AGREEMENT

Landlord: {landlord_name}
Tenant: {tenant_name}
Property: {property_name}, House {unit_number}
Monthly rent: KES {monthly_rent}
Deposit: KES {deposit_amount}
Rent due: {rent_due_day} of every month
Water: billed according to the property water billing configuration.
Notice period: {notice_period} days
Move-in date: {move_in_date}

Signature: ______________________`;

const available_placeholders = [
  "landlord_name",
  "tenant_name",
  "property_name",
  "unit_number",
  "monthly_rent",
  "deposit_amount",
  "rent_due_day",
  "notice_period",
  "move_in_date",
];

function validate_template_placeholders(content) {
  const placeholders = [
    ...String(content).matchAll(/\{([a-z_]+)\}/g),
  ].map((match) => match[1]);

  const invalid_placeholders = [
    ...new Set(
      placeholders.filter(
        (placeholder) =>
          !available_placeholders.includes(placeholder)
      )
    ),
  ];

  if (invalid_placeholders.length) {
    const error = new Error(
      `Unsupported agreement placeholder(s): ${invalid_placeholders
        .map((placeholder) => `{${placeholder}}`)
        .join(", ")}.`
    );

    error.status_code = 422;
    throw error;
  }
}

function format_currency(value) {
  return Number(value || 0).toLocaleString("en-KE", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

function format_date(value) {
  if (!value) {
    return "";
  }

  const date =
    typeof value === "string"
      ? new Date(`${value}T00:00:00.000Z`)
      : new Date(value);

  return new Intl.DateTimeFormat("en-KE", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function render_agreement_template({
  content,
  tenant,
  property,
  owner,
  notice_period_days,
}) {
  validate_template_placeholders(content);

  const landlord_name = [
    owner.first_name,
    owner.last_name,
  ]
    .filter(Boolean)
    .join(" ")
    .trim() || owner.phone;

  const values = {
    landlord_name,
    tenant_name: tenant.full_name,
    property_name: property.name,
    unit_number: tenant.unit_number,
    monthly_rent: format_currency(tenant.monthly_rent),
    deposit_amount: format_currency(
      tenant.rent_deposit_due
    ),
    /*
      The stored day is a number; templates read
      "Rent due: {rent_due_day} of every month".
    */
    rent_due_day: ordinal_day(property.rent_due_day),
    notice_period: String(notice_period_days),
    move_in_date: format_date(tenant.move_in_date),
  };

  return String(content).replace(
    /\{([a-z_]+)\}/g,
    (match, placeholder) =>
      Object.prototype.hasOwnProperty.call(
        values,
        placeholder
      )
        ? values[placeholder]
        : match
  );
}

module.exports = {
  default_template_content,
  available_placeholders,
  validate_template_placeholders,
  render_agreement_template,
};