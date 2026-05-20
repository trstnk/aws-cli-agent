/**
 * Sentinel error: the user pressed Ctrl-C during a prompt. Thrown from
 * inside tool `execute()` functions when Inquirer throws ExitPromptError,
 * propagated up through the agent loop, caught at the cli.ts boundary
 * where it triggers a clean exit with status 130.
 *
 * Using a custom class (not a string match) gives us reliable
 * `instanceof UserCancelledError` checks across all the places that need
 * to handle the cancellation differently from real errors.
 */
export class UserCancelledError extends Error {
  constructor(message = 'User cancelled the operation.') {
    super(message);
    this.name = 'UserCancelledError';
  }
}

/**
 * Sentinel error: the AWS CLI returned an exit code in FATAL_AWS_EXIT_CODES
 * (252-255). These indicate an unrecoverable condition — auth failure,
 * missing credentials, malformed request, AWS service failure — and
 * retrying won't help. The tool throws this instead of returning a result,
 * so the model never gets a chance to retry. The agent loop catches it,
 * propagates the stderr to the user, and exits 1.
 *
 * Carries the original cmd, exitCode, and stderr so cli.ts can surface
 * them to the user.
 */
export class FatalAwsCliError extends Error {
  constructor(
    readonly cmd: string,
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(
      `AWS CLI exited with code ${exitCode} (unrecoverable): ${stderr.trim() || '<no stderr>'}`,
    );
    this.name = 'FatalAwsCliError';
  }
}

/**
 * AWS CLI exit codes that indicate an unrecoverable condition:
 *   252 — Command-line parsing errors (typically a bug in our agent or
 *         the CLI itself; retrying won't help)
 *   253 — Profile/credentials not found in the credential chain
 *   254 — Client-side error (4xx from the service — auth, permission,
 *         malformed request)
 *   255 — Server-side error (5xx from the service — internal AWS issues)
 *
 * Anything else non-zero is a soft error (resource not found, etc.) and
 * gets returned to the model normally — it may try a different approach.
 * The model is bounded by `maxSteps` for runaway loops; we deliberately
 * don't impose a separate soft-failure cap.
 *
 * Exit code 130 (SIGINT) in interactive mode is treated as a clean user
 * cancellation, not an error — see aws-cli.ts's `effectivelyOk` rule.
 */
export const FATAL_AWS_EXIT_CODES = new Set([252, 253, 254, 255]);

/**
 * Wrap an Inquirer prompt call so that:
 *
 *   1. The prompt's question text renders on stderr, not stdout. Critical
 *      for `aca "..." > file.txt` — without this, the prompt would be
 *      silently swallowed into the redirected file while the user stared
 *      at a frozen terminal waiting for an invisible question.
 *
 *   2. Ctrl-C (which Inquirer reports as `ExitPromptError`) becomes our
 *      `UserCancelledError` sentinel. The Inquirer error class isn't
 *      easily importable, so we detect by `.name`.
 *
 * The `output` option lives on Inquirer's `context` parameter (the second
 * positional argument), NOT on the config object. Spreading it into the
 * config silently does nothing — TypeScript accepts the extra property,
 * but at runtime Inquirer ignores it. Pass the prompt as a thunk so we
 * can inject the context at the call site:
 *
 *   const ok = await wrapPrompt((ctx) =>
 *     confirm({ message: 'Execute?', default: true }, ctx),
 *   );
 *
 * The thunk pattern is slightly more verbose than `wrapPrompt(confirm(...))`
 * was, but it's the only shape that lets us centralize the context
 * injection. Forgetting to pass `ctx` through to the Inquirer call is
 * impossible to do silently — TypeScript will infer ctx's type and lint
 * unused parameters.
 */
export async function wrapPrompt<T>(
  factory: (ctx: { output: NodeJS.WritableStream }) => Promise<T>,
): Promise<T> {
  try {
    return await factory({ output: process.stderr });
  } catch (err) {
    if (err instanceof Error && err.name === 'ExitPromptError') {
      throw new UserCancelledError();
    }
    throw err;
  }
}
