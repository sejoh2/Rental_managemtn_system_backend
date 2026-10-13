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
  return storage.getStore();
}

module.exports = {
  run_as_admin,
  get_acting_admin,
};
