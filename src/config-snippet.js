#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.join(scriptDir, 'index.js');

const config = {
  mcpServers: {
    'local-web': {
      command: 'node',
      args: [indexPath],
      timeout: 60000,
    },
  },
};

process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
