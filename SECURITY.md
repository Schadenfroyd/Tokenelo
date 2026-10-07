# Security

## Supported releases

No public source or binary release is currently supported. The project is preparing an alpha release. A version support matrix will be added with that release.

## Report a vulnerability privately

Use the repository's **Security → Report a vulnerability** flow. If it is unavailable, open a public issue containing only a request for a private reporting channel, with no vulnerability details or sensitive attachments.

Include affected versions, impact and a minimal synthetic reproduction in the private report. Do not send credentials, raw session logs or a production database. Maintainers will assess reports as capacity permits; no remediation SLA is promised.

## Threat boundaries

The internal implementation uses a local authenticated read API, guarded Electron IPC and local storage. Optional fleet access and local metering proxies require deliberate configuration. Provider records and identifiers are untrusted inputs. Metadata, exports and API tokens are sensitive even when prompt bodies are not stored.

Local administrator access, a compromised account and a malicious upstream remain outside the protection offered by token accounting. Security review is ongoing; no external audit or compliance certification is claimed.
