# Release tokenmeter

The `Publish` workflow (`.github/workflows/publish.yml`) publishes or stages a version on npm with provenance.
A version tag on `main` starts it.

The workflow has two modes:

- When the `NPM_TOKEN` secret is set, the workflow stages the version with `npm stage publish`.
  The version is not live until the release owner approves it with 2FA.
  Use this mode for the first version only.
- When the `NPM_TOKEN` secret is empty, the workflow publishes with trusted publishing.
  npm signs in with the workflow identity. There is no token.

## Set up once

1. Make a GitHub environment with the name `npm`. Add the release owner as a required reviewer.
   Let only tags that match `v*.*.*` deploy to it.

## First version (staged)

npm can not add a trusted publisher to a package that is not on npm yet.
So the first version goes through a stage-only token.

1. On npmjs.com, make a granular access token with stage-only publish access.
   Give it access to the `@dean0x` scope only, with a short expiry.
2. Add the token as the `NPM_TOKEN` secret of the `npm` environment.
3. Publish the version (see "Publish").
4. Approve the staged version with 2FA immediately after the run passes:

   ```sh
   npm stage list @dean0x/tokenmeter
   npm stage approve '<stage-id>'
   ```

5. Delete the `NPM_TOKEN` secret. Revoke the token on npmjs.com.

npm makes a public placeholder version `0.0.0-stage` when it stages a package that is not on npm yet.
The npm docs do not say if a staged version keeps its provenance after approval.
For the first version, check the provenance once (see "Verify"). If it is not there, record that in the release notes.

## Later versions (trusted publishing)

1. Merge the version change to `main` (see "Prepare the version").
2. Sign in with `npm login`. Your npm account must have 2FA.
   Add the trusted publisher with npm 11.15.0 or newer:

   ```sh
   npm trust github @dean0x/tokenmeter --repo dean0x/tokenmeter --file publish.yml --env npm --allow-publish
   ```

3. Push the version tag within 2 days (see "Publish"). A new trusted publisher expires when no publish uses it in 2 days.
4. After that publish passes, open the package settings on npmjs.com.
   Under "Publishing access", select "Require two-factor authentication and disallow tokens".

## Prepare the version

1. Change the version in `package.json` and `package-lock.json` through a pull request to `main`.
2. Make a fresh clone of the repository. Use Node 22.18 or newer.
3. Install from the lockfile. Build the command. Run the canary test.

   ```sh
   npm ci
   npm run build
   node --test --test-concurrency=1 test/canary.test.ts
   npm pack --dry-run --json
   ```

4. Check that the file list has only `bin/`, `dist/`, `README.md`, `LICENSE` and `package.json`.
5. Check that the package has no install scripts and no runtime dependencies.

## Publish

1. Tag the merged commit on `main`. Replace `<version>` with the version in `package.json`.

   ```sh
   git switch main
   git pull --ff-only
   git tag -a 'v<version>' -m 'v<version>'
   git push origin 'v<version>'
   ```

2. Open the `Publish` run of the tag in the Actions tab. Approve the `npm` environment.
3. Confirm that the run passes. The run stops if the tag is not on `main` or does not agree with the version.
4. If the run staged the version, approve it (see "First version (staged)", step 4).

## Verify

1. On npmjs.com, confirm that the version shows a provenance statement for this repository.
2. Make a new folder outside the clone. Use the exact version that you published.

   ```sh
   verify_dir=$(mktemp -d)
   mkdir -m 700 "$verify_dir/data"
   cd "$verify_dir"
   TOKENMETER_DATA_DIR="$PWD/data" npx @dean0x/tokenmeter@<version> doctor --claude-root "$PWD/claude" --codex-root "$PWD/codex"
   ```

3. Confirm that `doctor` exits with code 0 and prints `"schema":"tokenmeter.v1"` and `"ok":true`.
