// SQL quoting lives in @totalbase/shared (no `pg`, so TotalBase's own catalog quotes the same way); the database
// package is where SQL is built, so it offers it too.
export { quoteIdentifier, quoteLiteral } from "@totalbase/shared";
