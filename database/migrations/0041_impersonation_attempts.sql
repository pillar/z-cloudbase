-- Wrong TOTP codes entered on an impersonation confirmation page (PRD §21.5.2): the request is cancelled
-- (end_reason 'too_many_attempts') after IMPERSONATION_MAX_CODE_ATTEMPTS failures.
ALTER TABLE impersonations ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0;
