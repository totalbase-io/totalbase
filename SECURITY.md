# Security

TotalBase stands between a database and the people and programs that reach it, so a security problem matters more than most bugs. Thank you for reporting one responsibly.

## Reporting a vulnerability

**Don't open a public issue.** Report it privately through GitHub: the repository's **Security** tab, **Report a vulnerability**. Include:

- what an attacker can do, and what they need first (an account, a role, a token, nothing);
- the steps or the request that shows it, and the version or commit;
- your PostgreSQL version, if it matters.

You'll hear back within a week. We'll agree with you on when the fix is published, credit you in the release notes if you want it, and keep the details private until a fixed release is out.

## Supported versions

During the beta, only the latest release gets security fixes. Upgrade to it before reporting, if you can.

## What's in scope

The Data API and its permissions (row filters, field grants, payload checks), authentication and sessions, the admin and the App, embeds, workflows, the MCP server, and anything that lets a caller reach data, SQL or privileges they weren't given. A role's capabilities are bounded by its PostgreSQL role: a report that needs a misconfigured database role, such as a superuser, is still welcome, but it's a configuration problem first.
