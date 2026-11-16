-- A token's allowed addresses (Security.md §3.5): the addresses and ranges a personal access token is accepted
-- from. NULL, the default, is anywhere. PostgreSQL holds them as inet and compares them itself
-- (`<<=` in UsersApisService.validate), so there is no second reading of a range in the application.
ALTER TABLE totalbase.tokens ADD COLUMN allowed_ips inet[];
ALTER TABLE totalbase.tokens ADD CONSTRAINT tokens_allowed_ips_count CHECK (allowed_ips IS NULL OR cardinality(allowed_ips) BETWEEN 1 AND 50);

COMMENT ON COLUMN totalbase.tokens.allowed_ips IS 'Addresses and CIDR ranges this token is accepted from (Security.md §3.5); NULL: from anywhere.';
