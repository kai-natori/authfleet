# Operator verification before production use

Status: **not performed**. Cloudflare deployment was excluded from the 0.2.0
release at the operator's request. Archiving the implementation changes records
their delivered code and local/CI checks; it does not certify a deployment.

The two originally planned runtime tasks are retained below, still unchecked.
They were moved from `add-authfleet-v1` and `add-agent-plugin` when closing the
implementation work. The README's development-only recommendation remains.
These checks belong to the operator and are not part of agent or CI verification.

## Dashboard and Access

- [ ] Runtime verification on the operator's Mac (dev servers, Access policy,
  real project registration).

Use the README setup instructions and an installation you control. Confirm the
web's exact custom domain is protected by an operator-only Access policy, both
Workers have `workers.dev` disabled, and API has no public route. Verify the
configured team domain, audience and API allowlist against that installation.
Do not enable `AUTHFLEET_DEV_BYPASS` in production.

Confirm an allowed operator can log in and an unlisted operator is denied.
Exercise project registration, stats and snapshots using a disposable project;
check the actual Access cookie/CSRF behavior and verify Worker logs contain no
project credentials. Confirm registry backup and original encryption-key
recovery before relying on the installation.

## Plugin and a non-D1 host

- [ ] Runtime verification on the operator's Mac (fixture app and dashboard
  against a real non-D1 project).

Use a supported Better Auth host and a disposable API key. On the operator's
machine, `pnpm test` includes the real-HTTP fixture that `pnpm test:unit` excludes.
Also connect the dashboard to an authorized non-D1 host, check that correct keys
work and wrong/missing keys fail, and compare the displayed counts with the host.
Confirm no user records or credentials appear in responses or logs and no target
database writes result from plugin requests.

## Record the outcome

Record the reviewed commit, date, installation, host/database versions, actual
results and any unresolved failures before checking either task. Keep secrets,
JWTs and user data out of the record. Unit tests or successful deployment alone
do not complete these runtime checks.
