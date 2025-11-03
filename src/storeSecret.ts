// Enhanced secret store helper
// Supports storing/listing/showing/deleting secrets via the configured provider
// and validates/normalizes Solana private keys when storing the wallet key.

import readline from 'readline';
import { loadConfig } from './config';
import { createSecretsProvider } from './secrets/provider';
import bs58 from 'bs58';
import fs from 'fs';
import path from 'path';

const DEFAULT_SERVICE = 'snipebt';

loadConfig();

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (q: string) => new Promise<string>(resolve => rl.question(q, resolve));

function parseKey(input: string): Uint8Array | null {
  let pk = (input || '').trim();
  if (!pk) return null;
  // strip quotes and whitespace
  if ((pk.startsWith('"') && pk.endsWith('"')) || (pk.startsWith("'") && pk.endsWith("'"))) {
    pk = pk.slice(1, -1);
  }
  pk = pk.replace(/\s+/g, '');

  // Try base58
  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
  if (base58Regex.test(pk)) {
    try {
      const bytes = bs58.decode(pk);
      if (bytes.length === 32 || bytes.length === 64) return bytes;
    } catch {}
  }

  // Try base64
  const base64Regex = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (base64Regex.test(pk)) {
    try {
      const buf = Buffer.from(pk, 'base64');
      if (buf.length === 32 || buf.length === 64) return new Uint8Array(buf);
    } catch {}
  }

  // Try JSON array
  if (pk.startsWith('[')) {
    try {
      const arr = JSON.parse(pk) as number[];
      if (Array.isArray(arr) && (arr.length === 32 || arr.length === 64) && arr.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) {
        return Uint8Array.from(arr);
      }
    } catch {}
  }

  // Try comma-separated bytes
  if (pk.includes(',')) {
    const parts = pk.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length === 32 || parts.length === 64) {
      const ok = parts.every(p => /^\d+$/.test(p));
      if (ok) {
        try {
          const nums = parts.map(p => parseInt(p, 10));
          return Uint8Array.from(nums);
        } catch {}
      }
    }
  }

  return null;
}

function usage() {
  console.log('Usage: node storeSecret.js --name <secret-name> [--value <value> | --file <path> | --env <ENV_VAR>] [--service <service>] [--account <account>]');
  console.log('Flags:');
  console.log('  --name       Name/key of the secret to store (e.g. WALLET_PRIVATE_KEY, TWITTER_BEARER)');
  console.log('  --value      Provide secret value directly');
  console.log('  --file       Read secret value from file path');
  console.log('  --env        Read secret value from an environment variable');
  console.log('  --service    Credential service name (default: snipebt)');
  console.log('  --account    Account label (default: the secret name)');
  console.log('  --list       List stored credentials for the service');
  console.log('  --show       Show the value for the given name (prints to stdout)');
  console.log('  --delete     Delete the secret for the given name');
  console.log('  --help       Show this help');
}

function parseArgs(argv: string[]) {
  const out: any = { flags: {} };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (['list', 'show', 'delete', 'help'].includes(key)) {
        out.flags[key] = true;
      } else {
        const val = argv[i+1];
        if (!val || val.startsWith('--')) {
          console.error(`Missing value for --${key}`);
          usage();
          process.exit(1);
        }
        out.flags[key] = val;
        i++;
      }
    } else {
      // ignore
    }
  }
  return out.flags;
}

async function run() {
  try {
    const flags = parseArgs(process.argv);

    if (flags.help) {
      usage();
      process.exit(0);
    }

    const service = flags.service || DEFAULT_SERVICE;
    const name = flags.name;
    const account = flags.account || name || 'default';
    const secretsProvider = createSecretsProvider({ service });

    if (flags.list) {
      const keys = await secretsProvider.listKeys();
      if (!keys || keys.length === 0) {
        console.log('No credentials found for service:', service);
        process.exit(0);
      }
      for (const key of keys) {
        console.log(key);
      }
      process.exit(0);
    }

    if (!name) {
      console.error('--name is required unless --list is used.');
      usage();
      process.exit(1);
    }

    if (flags.show) {
      const v = await secretsProvider.getSecret(account);
      if (!v) {
        console.error('No secret found for', account);
        process.exit(1);
      }
      console.log(v);
      process.exit(0);
    }

    if (flags.delete) {
      try {
        const deleted = await secretsProvider.deleteSecret(account);
        if (deleted) {
          console.log('Deleted secret for', account);
        } else {
          console.log('No secret found to delete for', account);
        }
      } catch (error) {
        console.error('Unable to delete secret:', (error as Error).message);
        process.exit(1);
      }
      process.exit(0);
    }

    // Acquire value
    let value: string | undefined = undefined;
    if (flags.value) {
      value = flags.value;
    } else if (flags.file) {
      const p = path.resolve(flags.file);
      if (!fs.existsSync(p)) {
        console.error('File does not exist:', p);
        process.exit(1);
      }
      value = fs.readFileSync(p, 'utf8').trim();
    } else if (flags.env) {
      value = process.env[flags.env];
      if (!value) {
        console.error('Environment variable', flags.env, 'is not set');
        process.exit(1);
      }
    } else {
      // Interactive prompt
      value = await question(`Enter value for ${name}: `);
    }

    if (!value) {
      console.error('No value provided; aborting.');
      process.exit(1);
    }

    // If the secret is a wallet key, validate and normalize to base58
    const normalizedName = (name || '').toLowerCase();
    if (['wallet', 'wallet_private_key', 'wallet-private-key', 'walletprivatekey', 'wallet_privatekey', 'walletprivate_key', 'wallet_private_key'.replace(/_/g, '')].includes(normalizedName) || normalizedName.includes('wallet') || name.toUpperCase() === 'WALLET_PRIVATE_KEY') {
      const parsed = parseKey(value);
      if (!parsed) {
        console.error('The provided wallet key is not in a recognized format. Accepted: base58/base64/JSON bytes/comma-separated bytes.');
        process.exit(1);
      }
      value = bs58.encode(parsed);
    }

    await secretsProvider.setSecret(account, value);
    console.log(`Stored secret '${name}' in service '${service}' under account '${account}'.`);
    console.log('Important: remove any plaintext copy from .env or filesystem if present.');
    process.exit(0);
  } catch (err) {
    console.error('Failed:', err);
    process.exit(1);
  } finally {
    try { rl.close(); } catch {}
  }
}

run();
