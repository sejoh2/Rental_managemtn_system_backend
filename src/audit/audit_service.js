const db = require("../config/db");

const {
  get_acting_admin,
  get_acting_caretaker,
} = require("./acting_context");

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
  /*
    An admin working inside an owner's account: the admin is
    the one who acted, in that owner's account.
  */
  const acting = get_acting_admin();

  if (
    acting &&
    String(user_id) === String(acting.owner_id)
  ) {
    user_id = acting.admin_id;
    owner_id = owner_id || acting.owner_id;
    metadata = {
      ...(metadata || {}),
      by_admin: true,
    };
  }

  /*
    A caretaker using one of the owner's actions: the caretaker
    is the one who acted, in their owner's account.
  */
  const caretaker = get_acting_caretaker();

  if (
    caretaker &&
    String(user_id) === String(caretaker.owner_id)
  ) {
    user_id = caretaker.caretaker_id;
    owner_id = owner_id || caretaker.owner_id;
    metadata = {
      ...(metadata || {}),
      by_caretaker: true,
    };
  }

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
          $7::record_id,
          (
            SELECT CASE
              WHEN role = 'owner' THEN user_id
              WHEN role = 'caretaker' THEN owner_id
              ELSE NULL
            END
            FROM users
            WHERE user_id = $1::record_id
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
