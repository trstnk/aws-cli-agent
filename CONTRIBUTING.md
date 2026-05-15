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

The release workflow publishes to npm on either a published GitHub Release
or a pushed tag matching `v*.*.*`. Either path requires the `NPM_TOKEN`
repository secret.

1. **Update the version** in `package.json` (also update `VERSION` in
   `src/cli.ts` to match, and add a section to `CHANGELOG.md`).
2. **Commit and merge** the version bump to `main`.
3. **Tag and push**:
   ```bash
   git tag v0.4.0
   git push origin v0.4.0
   ```
   …or create a GitHub Release through the web UI, which gives you a release
   notes editor on the way.
4. The `Release` workflow does the rest: it verifies `package.json` version
   matches the tag, runs the full CI pipeline, then publishes to npm with
   provenance attestation.

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
