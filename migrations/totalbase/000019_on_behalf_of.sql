-- On-behalf-of requests (Security.md §10.3): an application's backend acts because one of its users asked, with
-- a service user's token and the header X-TotalBase-On-Behalf-Of. The request is authorized as the caller; the
-- named user is recorded wherever the principal and the actor are - the audit entry, the outbox event - and
-- handed to triggers as totalbase.on_behalf_of_user_id. Who may: a role with the capability ACT_ON_BEHALF.

ALTER TABLE totalbase.roles_capabilities DROP CONSTRAINT roles_capabilities_capability_check;
ALTER TABLE totalbase.roles_capabilities ADD CONSTRAINT roles_capabilities_capability_check
  CHECK (capability = ANY (ARRAY['TRANSACTIONS'::text, 'SEND_EMAIL'::text, 'MANAGE_ROLES'::text, 'ACT_ON_BEHALF'::text]));
COMMENT ON TABLE totalbase.roles_capabilities IS 'What a role may do beyond rows: run multi-step transactions (TRANSACTIONS), send email from a workflow (SEND_EMAIL), manage the roles below it (MANAGE_ROLES), act on behalf of a user it can read (ACT_ON_BEHALF). ALLOW or DENY, one per role and capability.';

ALTER TABLE totalbase.logs ADD COLUMN on_behalf_of uuid;
ALTER TABLE totalbase.logs ADD CONSTRAINT logs_on_behalf_of_fkey FOREIGN KEY (on_behalf_of) REFERENCES totalbase.users(id) ON DELETE SET NULL;
CREATE INDEX logs_on_behalf_of_idx ON totalbase.logs (on_behalf_of, created_at) WHERE on_behalf_of IS NOT NULL;
COMMENT ON COLUMN totalbase.logs.on_behalf_of IS 'The user the request was made for (X-TotalBase-On-Behalf-Of, Security.md §10.3): recorded beside the principal and the actor, never a grant of theirs; NULL when nobody was named or the account is since deleted.';

ALTER TABLE totalbase.outbox ADD COLUMN on_behalf_of uuid;
COMMENT ON COLUMN totalbase.outbox.on_behalf_of IS 'The user the write was made for (X-TotalBase-On-Behalf-Of), for the workflows and webhooks the event reaches.';
