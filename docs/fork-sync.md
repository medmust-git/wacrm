# Syncing this fork with upstream

This repository (`medmust-git/wacrm`) is a fork of
[`ArnasDon/wacrm`](https://github.com/ArnasDon/wacrm). MedMust's changes live
on `main` alongside everything merged from upstream.

```bash
git remote add upstream https://github.com/ArnasDon/wacrm.git   # once
git fetch upstream
git checkout -b sync/upstream-YYYY-MM-DD main
git merge --no-ff upstream/main
```

Merge, do not rebase: `main` is what Cloud Run images are built from, and
rewriting it would orphan the commits those images name.

## Migration numbers - the part that fails silently

Supabase records applied migrations by their numeric prefix. If upstream ships
a migration with a number the fork has **already applied**, `supabase db push`
treats upstream's file as done and skips it. No error, and the schema is
quietly missing upstream's change.

This happened on the 2026-09-14 sync. The fork had applied
`040_flow_integrations_catalog` and `041_flow_set_vars`; upstream had shipped
`040_contact_business_scoped_user_id`, `041_fix_broadcast_contact_id_ambiguity`
and `042_message_failure_reason`. Resolution:

1. Renumber the fork's migrations after upstream's highest
   (`043_flow_integrations_catalog`, `044_flow_set_vars`). They are idempotent,
   so running them again under the new number is harmless.
2. Tell the database the old numbers were not upstream's:
   ```bash
   supabase migration repair --status reverted 040 041
   supabase db push --dry-run    # must list 040, 041, 042, 043, 044
   supabase db push
   ```
3. `supabase/ci/verify-schema.sql` asserts upstream's migrations actually took
   effect; run it against the database after pushing.

**Rule for future fork migrations:** keep them idempotent (`IF NOT EXISTS`,
drop-and-recreate for CHECKs), so a renumbering like this is always safe.

## Translation catalogues

`src/i18n/messages.test.ts` requires every locale to carry every `en.json` key.
Fork-only keys (the flow builder's integration nodes) must be added to every
upstream locale after a sync - upstream adds locales (pt and es arrived in the
2026-09-14 sync).
