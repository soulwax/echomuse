// File: src/index.ts

import makeDir from 'make-dir';
import path from 'path';
import Bot from './bot.js';
import container from './inversify.config.js';
import Config from './services/config.js';
import FileCacheProvider from './services/file-cache.js';
import { TYPES } from './types.js';


console.log('Current working directory:', process.cwd());
console.log('Current user:', require('os').userInfo().username);
console.log('Node.js version:', process.version);

const bot = container.get<Bot>(TYPES.Bot);

const startBot = async () => {
  // Create data directories if necessary
  const config = container.get<Config>(TYPES.Config);

  await makeDir(config.DATA_DIR);
  await makeDir(config.CACHE_DIR);
  await makeDir(path.join(config.CACHE_DIR, 'tmp'));

  await container.get<FileCacheProvider>(TYPES.FileCache).cleanup();

  await bot.register();
};

export { startBot };

