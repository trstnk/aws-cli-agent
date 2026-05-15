#!/usr/bin/env node
import { main } from './cli.js';

main(process.argv).catch((err: unknown) => {
  process.stderr.write(
    'Fatal: ' + (err instanceof Error ? err.message : String(err)) + '\n',
  );
  process.exit(1);
});
