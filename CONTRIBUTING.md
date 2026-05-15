# Contributing to aws-cli-agent

## Local development

```bash
git clone https://github.com/<your-org>/aws-cli-agent.git
cd aws-cli-agent
npm install
```

Iterate from source (no build step):

```bash
npm run dev -- "list buckets in my-staging"
```

Type-check continuously in a second terminal:

```bash
npx tsc --noEmit --watch
```

## Before opening a PR

Run the same checks CI will run:

```bash
npm run ci
```

That's a shortcut for: `lint` → `typecheck` → `build` → `test` (smoke test).

Equivalent individually:

```bash
npm run lint        # ESLint
npm run typecheck   # tsc --noEmit
npm run build       # tsc → dist/
npm test            # smoke test against the built CLI
```

`npm run lint:fix` auto-fixes what's auto-fixable.

## Cutting a release

The release workflow publishes to npm when a **GitHub Release** is published.
Requires the `NPM_TOKEN` repository secret.

1. **Update the version** in `package.json` (also update `VERSION` in
   `src/cli.ts` to match, and add a section to `CHANGELOG.md`).
2. **Commit and merge** the version bump to `main`.
3. **Create a GitHub Release**:
   - Web UI: **Releases → Draft a new release**. Set the tag to `vX.Y.Z`
     (created on publish), pick `main` as the target, write release notes
     (or auto-generate from PR titles), then **Publish release**.
   - CLI alternative: `gh release create v0.4.0 --notes "..."` — `gh` creates
     the tag for you in the same step.
4. The `Release` workflow does the rest: verifies `package.json` version
   matches the tag, runs the full CI pipeline, then publishes to npm with
   provenance attestation.

> **Why not `git push --tags` to publish?** The workflow listens only for
> the `release:published` event, not raw tag pushes. Listening for both
> would race two workflow runs for the same publish; the second always
> fails with "cannot publish over previously published versions." Using
> GitHub Releases also gives you a release-notes editor and a proper
> deletable-if-broken artifact, which raw tags don't.

### One-time setup

In the repository settings on GitHub:

1. **Generate an npm automation token** at https://www.npmjs.com/settings/<your-username>/tokens
   (Granular Access Token with `Read and write` on the `aws-cli-agent` package).
2. **Add it as a repository secret** named `NPM_TOKEN`.

The `id-token: write` permission is already granted in the workflow file; it
unlocks [npm provenance](https://docs.npmjs.com/generating-provenance-statements),
which records on the npm registry exactly which GitHub Actions run produced
each published version.

## Project structure

```
src/
├── index.ts          # entry point (shebang); delegates to cli.ts
├── cli.ts            # commander setup, top-level command handlers
├── agent.ts          # Vercel AI SDK generateText loop
├── config.ts         # Zod schema for the JSON config
├── paths.ts          # XDG path resolution
├── providers.ts      # LLM provider factory (Anthropic/OpenAI/Google/Bedrock)
├── logger.ts         # general-purpose stderr + file logger
├── audit.ts          # JSONL audit logger
├── reasoning.ts      # reasoning step logger
├── history.ts        # JSONL command history
└── tools/
    ├── index.ts      # composes the tool set for the agent
    ├── aws-cli.ts    # execute_aws_command tool
    ├── bash.ts       # execute_bash_script tool (3-way prompt)
    ├── history.ts    # query_history tool
    ├── prompt.ts     # prompt_user tool
    └── profiles.ts   # list_aws_profiles tool

scripts/
└── smoke-test.mjs    # CI smoke tests against the built CLI

.github/
├── workflows/
│   ├── ci.yml        # lint, typecheck, build, test on push and PR
│   └── release.yml   # publish to npm on tag / release
└── dependabot.yml    # weekly npm + monthly actions dependency updates
```

## Adding a new tool

Tools are the agent's only handles on the outside world. To add one:

1. Create `src/tools/<name>.ts` exporting a factory that returns a `tool({...})`
   from the `ai` package.
2. Register it in `src/tools/index.ts` under `createTools`.
3. Update the system prompt in `src/agent.ts` to describe when the model
   should use it.
4. If the tool can execute non-trivial actions, route them through the
   approval prompt and the audit logger.
