/** Author history is immutable data; only the live account link follows account lifetime. */
export const contributionSchema = `
CREATE TABLE dsh_phalanx.contributions(
 id text PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('skill','plugin')), name text NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','adopted','declined','withdrawn')),
 live_space_id text REFERENCES dsh_phalanx.accounts(space_id) ON DELETE SET NULL,
 record jsonb NOT NULL CHECK(jsonb_typeof(record)='object'), row_revision text NOT NULL);
CREATE INDEX contributions_author ON dsh_phalanx.contributions(live_space_id,status);
CREATE INDEX contributions_name ON dsh_phalanx.contributions(kind,name,status);
CREATE FUNCTION dsh_phalanx.remove_pending_contributions() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN DELETE FROM dsh_phalanx.contributions WHERE live_space_id=OLD.space_id AND status='pending'; RETURN OLD; END $$;
CREATE TRIGGER remove_pending_contributions BEFORE DELETE ON dsh_phalanx.accounts
 FOR EACH ROW EXECUTE FUNCTION dsh_phalanx.remove_pending_contributions();
`
