# License and corresponding source

This revision uses AGPL-3.0-only for Drake-owned software. Third-party
software/assets, user uploads, private records, secrets and service credentials
are not relicensed by this notice. Preserve all dependency licenses and notices.
A dependency API does not automatically make every independent client AGPL;
incorporating or linking covered code needs a separate compatibility review.

## Reproduce the software

This maintenance revision is a buildless library with no test script or
committed lockfile. Use package.json, sql/session-table.sql and README.md.
DCC pins its installed dependency versions with its own lockfile.

```sh
npm install --ignore-scripts
npm pack --ignore-scripts
# Buildless library: see README.md and sql/session-table.sql.
```

Use fresh local test services. Do not include a real .env, tokens, database
exports, account information, journals, scripts/books, recordings or uploads
in any source archive. Provide configuration descriptions and schemas instead.
Include the complete source needed to modify and run this exact revision,
including dependency source/notices where required and local modifications.
An npm runtime tarball by itself may omit build inputs: use the full, reviewed
source tree for the corresponding-source offer.
