const db = require("../config/db");

/*
  The database itself announces when something a bell counts has
  changed, whichever part of the code (or a background job, or an
  M-Pesa callback) made the change. Each announcement only says
  whose bell changed; the browser then asks for the counts the
  normal, signed-in way.

  PostgreSQL sends one announcement per transaction for identical
  messages, so sending 200 SMS in one go is one announcement.

  Safe to run again: everything is replaced on each start.
*/
async function init_live_tables() {
  await db.query(`
    CREATE OR REPLACE FUNCTION announce_bell_change()
    RETURNS TRIGGER AS
    $$
    DECLARE
      row_owner_id BIGINT;
    BEGIN
      IF TG_ARGV[0] = 'admin' THEN
        PERFORM pg_notify('bell_changed', '{"to":"admin"}');
      ELSE
        row_owner_id := COALESCE(
          (to_jsonb(NEW) ->> 'owner_id')::BIGINT,
          (to_jsonb(OLD) ->> 'owner_id')::BIGINT
        );

        IF row_owner_id IS NOT NULL THEN
          PERFORM pg_notify(
            'bell_changed',
            json_build_object(
              'to', 'owner',
              'owner_id', row_owner_id
            )::TEXT
          );
        END IF;
      END IF;

      RETURN NULL;
    END;
    $$
    LANGUAGE plpgsql;

    /*
      The admin's bell: people waiting for a role, sender IDs
      waiting for approval, and sign-in alarms.
    */
    DROP TRIGGER IF EXISTS bell_users ON users;
    CREATE TRIGGER bell_users
      AFTER INSERT OR DELETE OR UPDATE OF role, status ON users
      FOR EACH ROW
      EXECUTE FUNCTION announce_bell_change('admin');

    DROP TRIGGER IF EXISTS bell_sender_approvals ON sms_sender_approvals;
    CREATE TRIGGER bell_sender_approvals
      AFTER INSERT OR DELETE OR UPDATE OF status ON sms_sender_approvals
      FOR EACH ROW
      EXECUTE FUNCTION announce_bell_change('admin');

    DROP TRIGGER IF EXISTS bell_sign_in_alarms ON audit_logs;
    CREATE TRIGGER bell_sign_in_alarms
      AFTER INSERT ON audit_logs
      FOR EACH ROW
      WHEN (NEW.action IN ('LOGIN_FAILED', 'OTP_REQUESTED'))
      EXECUTE FUNCTION announce_bell_change('admin');

    /*
      Each owner's bell: unmatched payments, flagged readings,
      failed SMS and open repairs, in their own account only.
    */
    DROP TRIGGER IF EXISTS bell_payments ON payments;
    CREATE TRIGGER bell_payments
      AFTER INSERT OR DELETE OR UPDATE OF status ON payments
      FOR EACH ROW
      EXECUTE FUNCTION announce_bell_change('owner');

    DROP TRIGGER IF EXISTS bell_water_readings ON water_meter_readings;
    CREATE TRIGGER bell_water_readings
      AFTER INSERT OR DELETE OR UPDATE OF status ON water_meter_readings
      FOR EACH ROW
      EXECUTE FUNCTION announce_bell_change('owner');

    DROP TRIGGER IF EXISTS bell_maintenance ON maintenance_requests;
    CREATE TRIGGER bell_maintenance
      AFTER INSERT OR DELETE OR UPDATE OF status ON maintenance_requests
      FOR EACH ROW
      EXECUTE FUNCTION announce_bell_change('owner');

    /*
      SMS change status many times while sending; only a change
      into or out of "failed" matters to the bell.
    */
    DROP TRIGGER IF EXISTS bell_sms_failed ON sms_messages;
    CREATE TRIGGER bell_sms_failed
      AFTER UPDATE OF status ON sms_messages
      FOR EACH ROW
      WHEN (
        OLD.status IS DISTINCT FROM NEW.status
        AND 'failed' IN (OLD.status, NEW.status)
      )
      EXECUTE FUNCTION announce_bell_change('owner');

    DROP TRIGGER IF EXISTS bell_sms_removed ON sms_messages;
    CREATE TRIGGER bell_sms_removed
      AFTER DELETE ON sms_messages
      FOR EACH ROW
      WHEN (OLD.status = 'failed')
      EXECUTE FUNCTION announce_bell_change('owner');
  `);

  console.log("[LIVE] Bell announcements ready.");
}

module.exports = {
  init_live_tables,
};
