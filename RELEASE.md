# Release tokenmeter

The `Publish` workflow (`.github/workflows/publish.yml`) publishes to npm with provenance.
A version tag on `main` starts it.

## Set up once

1. Make a GitHub environment with the name `npm`. Add the release owner as a required reviewer.
2. On npmjs.com, add this repository and the `publish.yml` workflow as a trusted publisher of `@dean0x/tokenmeter`.
3. If the package is not on npm yet, you can not add a trusted publisher.
   For that first version, add a granular npm token as the `NPM_TOKEN` secret of the `npm` environment.
   Give the token publish access to the `@dean0x` scope only, with a short expiry.
   After the first publish, add the trusted publisher and delete the secret.

## Prepare the version

1. Change the version in `package.json` and `package-lock.json` through a pull request to `main`.
   Add the version entry to `CHANGELOG.md` in the same pull request.
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
