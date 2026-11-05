# Security policy

## Reporting a security issue

Please report privately, not in a public issue.

- Use the private advisory form on the Security tab of this repository, or
- contact the maintainer through the details on their GitHub profile.

Include what you did, what happened, and the version reported by the `/healthz` endpoint. You will get
an acknowledgement within a few days. Please give a reasonable window to ship a fix before publishing.

## Supported versions

The `main` branch and the latest tagged release. Older commits are not patched.

## In scope

Authentication and session handling, authorization between conversations, file upload and
delivery, injection, XSS/CSP, CSRF, rate limiting, and anything that leaks message content or metadata
across accounts.

Out of scope by design (see [docs/SECURITY.md](../docs/SECURITY.md)): the server operator
reading messages (there is no end-to-end encryption), denial of service at the network layer, and
anything requiring a compromised host or browser.

The full threat model, the control-by-control implementation notes and the known limitations live in
[docs/SECURITY.md](../docs/SECURITY.md).
