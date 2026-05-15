import path from 'node:path';
import os from 'node:os';

/**
 * Resolve an XDG path strictly per the Base Directory Specification.
 * Falls back to the canonical default if the env var is unset OR empty.
 * (env-paths is not used here because it diverges from XDG on macOS.)
 */
function xdg(envVar: string, fallback: string): string {
  const v = process.env[envVar];
  return v && v.length > 0 ? v : fallback;
}

const home = os.homedir();

const APP = 'aws-cli-agent';

/**
 * Directories aws-cli-agent uses:
 *
 *   config — user config (`~/.config/aws-cli-agent`)
 *   state  — history + logs (`~/.local/state/aws-cli-agent`)
 *   data   — user-curated artifacts: default location for saved scripts
 *            (`~/.local/share/aws-cli-agent`). Only created on demand.
 */
export const PATHS = {
  config: path.join(xdg('XDG_CONFIG_HOME', path.join(home, '.config')), APP),
  state: path.join(xdg('XDG_STATE_HOME', path.join(home, '.local', 'state')), APP),
  data: path.join(xdg('XDG_DATA_HOME', path.join(home, '.local', 'share')), APP),
} as const;

export const FILES = {
  config: path.join(PATHS.config, 'config.json'),
  history: path.join(PATHS.state, 'history.jsonl'),
  log: path.join(PATHS.state, 'general.log'),
  audit: path.join(PATHS.state, 'audit.log'),
  reasoning: path.join(PATHS.state, 'reasoning.log'),
  usage: path.join(PATHS.state, 'usage.log'),
} as const;

/** Default location for user-saved bash scripts. */
export const DEFAULT_SCRIPT_FOLDER = path.join(PATHS.data, 'scripts');
