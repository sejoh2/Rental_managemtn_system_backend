const { AsyncLocalStorage } = require("async_hooks");

/*
  A system admin may work inside an owner's account. For the
  length of such a request this holds who the admin is and
  which account they are in, so the audit log can record the
  admin as the person who acted.
*/
const storage = new AsyncLocalStorage();

function run_as_admin(context, callback) {
  return storage.run(context, callback);
}

/*
  { admin_id, owner_id } during an admin's request inside an
  owner's account; undefined otherwise.
*/
function get_acting_admin() {
  const acting = storage.getStore();

  return acting && acting.admin_id ? acting : undefined;
}

/*
  A caretaker may use some of the owner's actions in a property
  they are assigned to (see caretakers/caretaker_acting.js).
  The request then runs as the owner, and this holds who the
  caretaker is, so the audit log records them as the person who
  acted.
*/
function run_as_caretaker(context, callback) {
  return storage.run(context, callback);
}

/*
  { caretaker_id, owner_id } during such a request; undefined
  otherwise.
*/
function get_acting_caretaker() {
  const acting = storage.getStore();

  return acting && acting.caretaker_id ? acting : undefined;
}

module.exports = {
  run_as_admin,
  get_acting_admin,
  run_as_caretaker,
  get_acting_caretaker,
};
