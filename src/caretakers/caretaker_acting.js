const db = require("../config/db");

const {
  get_user_by_id,
} = require("../auth/auth_service");

const {
  run_as_caretaker,
} = require("../audit/acting_context");

const {
  get_caretaker_property_access,
} = require("./caretaker_access_service");

const { PREFIX, is_id, id_or_throw } = require("../utils/ids");

function refuse(message, status_code) {
  const error = new Error(message);

  error.status_code = status_code;
  return error;
}

// A record ID (of the kind prefix, when given), or null.
function id_or_null(value, prefix = null) {
  return is_id(value, prefix) ? value : null;
}

/*
  Lets a caretaker use a route that was written for the owner.

  Place it after authenticate and require_role("owner",
  "caretaker"). An owner passes straight through. For a
  caretaker it finds the property the request is about, checks
  that they are assigned to it (and hold the level or the
  permission asked for), and then runs the request as the owner
  of that property, so every owner rule works unchanged. The
  audit log still records the caretaker as the person who acted.

  property    (req, owner_id) => the property's ID, or
              { property_id, level }, or null when the record
              is not in the owner's account
  level       "level_1" (the default) or "level_2"
  permission  a yes/no column of the assignment that must be on
*/
function as_owner({
  property,
  level = "level_1",
  permission = null,
  permission_message =
    "The owner has not allowed you to do this.",
}) {
  return async function caretaker_as_owner(req, res, next) {
    try {
      if (req.user.role !== "caretaker") {
        return next();
      }

      const caretaker = req.user;

      const found = await property(req, caretaker.owner_id);

      const property_id = id_or_null(
        found && typeof found === "object"
          ? found.property_id
          : found,
        PREFIX.property
      );

      if (!property_id) {
        throw refuse(
          "Not found, or you do not have access to it.",
          404
        );
      }

      const assignment =
        await get_caretaker_property_access(
          db,
          caretaker,
          property_id,
          (found && found.level) || level
        );

      if (permission && assignment[permission] !== true) {
        throw refuse(permission_message, 403);
      }

      const owner = await get_user_by_id(caretaker.owner_id);

      if (
        !owner ||
        owner.role !== "owner" ||
        owner.status !== "active"
      ) {
        throw refuse(
          "The owner's account is not available.",
          403
        );
      }

      req.caretaker = caretaker;
      req.caretaker_assignment = assignment;

      req.user = {
        ...owner,
        acting_caretaker_id: caretaker.user_id,
      };

      return run_as_caretaker(
        {
          caretaker_id: caretaker.user_id,
          owner_id: owner.user_id,
        },
        next
      );
    } catch (error) {
      return next(error);
    }
  };
}

/*
  The property named in the address:
  /properties/:property_id/...
  A malformed ID is refused with 422, as it is for the owner.
*/
function property_in_path(req) {
  return id_or_throw(req.params.property_id, "property", PREFIX.property);
}

// The kind of record each table holds, for the ID check below.
const RECORD_KIND = {
  tenants: [PREFIX.tenant, "tenant"],
  water_meter_readings: [PREFIX.water_reading, "reading"],
};

/*
  The property of a record named in the address, such as the
  tenant in /tenants/:tenant_id/... The table name comes from
  the code, never from the request.
*/
function property_of_record(table, param) {
  const [prefix, label] = RECORD_KIND[table] || [null, "record"];

  return async function find_property(req, owner_id) {
    // A malformed ID is refused with 422, as it is for the owner.
    const id = id_or_throw(req.params[param], label, prefix);

    const result = await db.query(
      `
        SELECT property_id
        FROM ${table}
        WHERE id = $1
          AND owner_id = $2
      `,
      [id, owner_id]
    );

    return result.rows[0]?.property_id || null;
  };
}

module.exports = {
  as_owner,
  property_in_path,
  property_of_record,
};
