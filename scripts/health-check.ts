#!/usr/bin/env ts-node

import { loadConfig } from '../src/config';

const main = async () => {
  loadConfig();
  console.log('Health check placeholder - implement in later tasks.');
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
