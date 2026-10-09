const db = require("../config/db");

/*
  Records who did what, to which record, in which owner account.

  owner_id is the account the action belongs to. When it is not
  given it is taken from the acting user: an owner acts in their
  own account, a caretaker in their owner's account.
  Pass it explicitly for automatic actions that have no user,
  and for admin actions on someone else's account.
*/
async function log_audit({
  user_id = null,
  owner_id = null,
  action,
  entity_type = null,
  entity_id = null,
  metadata = null,
  ip_address = null,
}) {
  await db.query(
    `
      INSERT INTO audit_logs (
        user_id,
        action,
        entity_type,
        entity_id,
        metadata,
        ip_address,
        owner_id
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,
        COALESCE(
          $7::BIGINT,
          (
            SELECT CASE
              WHEN role = 'owner' THEN user_id
              WHEN role = 'caretaker' THEN owner_id
              ELSE NULL
            END
            FROM users
            WHERE user_id = $1::BIGINT
          )
        )
      )
    `,
    [
      user_id,
      action,
      entity_type,
      entity_id,
      metadata ? JSON.stringify(metadata) : null,
      ip_address,
      owner_id,
    ]
  );
}

module.exports = {
  log_audit,
};
