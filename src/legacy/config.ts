import bs58 from 'bs58';
import { 
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  ConnectionConfig
} from '@solana/web3.js';
import { secureConfig } from '../secureConfig';

// Note: we intentionally avoid accessing secureConfig at module import time
// because secureConfig.initialize() must run first (it loads .env and OS store).
// Validation of required environment variables will happen inside initializeAndLog().

// Constants validation
export const CONSTANTS = {
  RAYDIUM_PROGRAM_ID: new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'),
  NATIVE_MINT: new PublicKey('So11111111111111111111111111111111111111112'),
  MIN_SOL_BALANCE: 0.05,
  RPC_TIMEOUT_MS: 20000,          // Increased timeout
  HEALTH_CHECK_INTERVAL_MS: 60000, // Check health every minute
  MAX_RETRIES: 5,                 // More retries
  MIN_RETRY_DELAY: 5000,          // Start with 5 second delay
  MAX_RETRY_DELAY: 60000,         // Max 1 minute delay
  CONNECTION_COMMITMENT: 'processed' as const,
} as const;

// Connection configuration with rate limit handling
const connectionConfig: ConnectionConfig = {
  commitment: CONSTANTS.CONNECTION_COMMITMENT,
  confirmTransactionInitialTimeout: CONSTANTS.RPC_TIMEOUT_MS,
  wsEndpoint: process.env.RPC_WSS_URL || undefined,
  disableRetryOnRateLimit: false,
  httpHeaders: {
    'Content-Type': 'application/json',
  },
};

// Wallet initialization with security checks
const initializeWallet = () => {
  console.log('Initializing wallet...');
  const privateKey = secureConfig.getSensitiveValue('WALLET_PRIVATE_KEY', 'wallet initialization');
  
  try {
    console.log('Decoding private key...');

    // Be flexible about accepted formats: base58 string, base64 string, JSON array of bytes, or comma-separated bytes
    let pk = privateKey.trim();
    let secretKeyBytes: Uint8Array | null = null;

    // Remove wrapping quotes if present
    if ((pk.startsWith('"') && pk.endsWith('"')) || (pk.startsWith("'") && pk.endsWith("'"))) {
      pk = pk.slice(1, -1);
    }
    // Remove any whitespace/newlines
    pk = pk.replace(/\s+/g, '');

    // Base58 fast-path (only characters in base58 alphabet)
    const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
    if (base58Regex.test(pk)) {
      try {
        secretKeyBytes = bs58.decode(pk);
        console.log(`Detected base58 format; decoded length: ${secretKeyBytes.length} bytes`);
      } catch (e) {
        // fall through to other parsers
        console.warn('Base58 decode failed, will attempt alternative parsing');
      }
    }

    // Try base64 (common when exported from some tools)
    if (!secretKeyBytes) {
      const base64Regex = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
      if (base64Regex.test(pk)) {
        try {
          const buf = Buffer.from(pk, 'base64');
          if (buf.length > 0) {
            secretKeyBytes = new Uint8Array(buf);
            console.log(`Detected base64 format; length: ${secretKeyBytes.length} bytes`);
          }
        } catch (e) {
          // ignore
        }
      }
    }

    // Try JSON array format (e.g. [1,2,3,...])
    if (!secretKeyBytes && pk.startsWith('[')) {
      try {
        const arr = JSON.parse(pk) as number[];
        if (Array.isArray(arr) && arr.every(n => typeof n === 'number')) {
          secretKeyBytes = Uint8Array.from(arr);
          console.log(`Detected JSON-array format; length: ${secretKeyBytes.length} bytes`);
        }
      } catch (e) {
        // ignore and continue
      }
    }

    // Try comma-separated numeric bytes
    if (!secretKeyBytes && pk.includes(',')) {
      const parts = pk.split(',').map(s => s.trim()).filter(Boolean);
      if (parts.every(p => /^\d+$/.test(p))) {
        try {
          const nums = parts.map(p => parseInt(p, 10));
          secretKeyBytes = Uint8Array.from(nums);
          console.log(`Detected comma-separated byte format; length: ${secretKeyBytes.length} bytes`);
        } catch (e) {
          // ignore
        }
      }
    }

    if (!secretKeyBytes) {
      throw new Error('Private key not in a recognized format (base58, base64, JSON array, or comma-separated bytes)');
    }

    let keypair: Keypair;

    // 64-byte: full secretKey (secret + public)
    if (secretKeyBytes.length === 64) {
      try {
        keypair = Keypair.fromSecretKey(secretKeyBytes);
        console.log('Loaded Keypair from 64-byte secretKey');
        console.log(`Wallet initialized successfully. Public key: ${keypair.publicKey.toString()}`);
        return keypair;
      } catch (e64) {
        console.warn('Failed to load 64-byte secretKey directly, will attempt 32-byte seed fallback');
        // fall through to try 32-byte seed
      }
    }

    // 32-byte: seed form — derive Keypair from seed
    if (secretKeyBytes.length === 32 || secretKeyBytes.length === 64) {
      const seed = secretKeyBytes.slice(0, 32);
      try {
        keypair = Keypair.fromSeed(seed as Uint8Array);
        console.log('Derived Keypair from 32-byte seed');
        console.log(`Wallet initialized successfully. Public key: ${keypair.publicKey.toString()}`);
        return keypair;
      } catch (eSeed) {
        throw new Error(`Failed to derive Keypair from seed: ${eSeed instanceof Error ? eSeed.message : String(eSeed)}`);
      }
    }

  throw new Error(`Invalid private key length: ${secretKeyBytes.length} bytes (expected 32 or 64)`);

  } catch (error) {
    throw new Error(`Failed to initialize wallet: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

// List of public RPC endpoints
const PUBLIC_RPC_ENDPOINTS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-api.projectserum.com',
  'https://rpc.ankr.com/solana'
];

// RPC configuration with fallback
const initializeConnections = () => {
  const primaryEndpoint = process.env.RPC_URL || PUBLIC_RPC_ENDPOINTS[0];
  const backupEndpoint = process.env.BACKUP_RPC_URL || PUBLIC_RPC_ENDPOINTS[1];

  const primary = {
    endpoint: primaryEndpoint,
    connection: new Connection(primaryEndpoint, connectionConfig)
  };

  const backup = {
    endpoint: backupEndpoint,
    connection: new Connection(backupEndpoint, connectionConfig)
  };

  return { primary, backup };
};

// Health monitoring
let isHealthy = true;
const startHealthCheck = (connection: Connection) => {
  return setInterval(async () => {
    try {
      await connection.getLatestBlockhash();
      if (!isHealthy) {
        console.log('RPC connection restored');
        isHealthy = true;
      }
    } catch (error) {
      isHealthy = false;
      console.error('RPC health check failed:', error instanceof Error ? error.message : 'Unknown error');
      // Switch to backup if primary fails
      if (connection.rpcEndpoint === connections.primary.endpoint) {
        console.log('Switching to backup RPC endpoint...');
        rpc = connections.backup.connection;
      }
    }
  }, CONSTANTS.HEALTH_CHECK_INTERVAL_MS);
};

// Exported placeholders (will be set by initializeAndLog)
export let wallet: Keypair;
export let connections: ReturnType<typeof initializeConnections>;
export let rpc: Connection;

// Export utility functions
export const getConnectionHealth = () => isHealthy;

export const validateBalance = async (minimumSol = CONSTANTS.MIN_SOL_BALANCE) => {
  if (!rpc || !wallet) throw new Error('RPC or wallet not initialized');
  const balance = await rpc.getBalance(wallet.publicKey);
  const balanceInSOL = balance / LAMPORTS_PER_SOL;
  if (balanceInSOL < minimumSol) {
    throw new Error(`Low balance warning: ${balanceInSOL.toFixed(4)} SOL (minimum: ${minimumSol} SOL)`);
  }
  return balanceInSOL;
};

// Initialize and log status (call this from main before using wallet/rpc)
export const initializeAndLog = async () => {
  console.log('Initializing secure configuration...');
  await secureConfig.initialize();
  secureConfig.enableMemoryProtection();
  console.log('Secure configuration initialized');

  // Validate required environment variables after secure config is ready
  const requiredEnvVars = ['RPC_URL', 'BACKUP_RPC_URL', 'ENVIRONMENT'];
  const missingVars: string[] = [];

  // WALLET_PRIVATE_KEY is sensitive and accessed via secureConfig.getSensitiveValue
  try {
    secureConfig.getSensitiveValue('WALLET_PRIVATE_KEY', 'initialization');
  } catch (err) {
    missingVars.push('WALLET_PRIVATE_KEY');
  }

  for (const v of requiredEnvVars) {
    const val = secureConfig.getValue(v);
    if (!val) missingVars.push(v);
  }

  if (missingVars.length > 0) {
    throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
  }

  if (!['production', 'development'].includes(process.env.ENVIRONMENT!)) {
    throw new Error('ENVIRONMENT must be either "production" or "development"');
  }

  // Initialize runtime components
  wallet = initializeWallet();
  connections = initializeConnections();
  rpc = connections.primary.connection;

  // Start health monitoring
  startHealthCheck(rpc);

  const balance = await rpc.getBalance(wallet.publicKey);
  console.log({
    environment: process.env.ENVIRONMENT,
    wallet: `${wallet.publicKey.toBase58().slice(0, 4)}...${wallet.publicKey.toBase58().slice(-4)}`,
    balance: (balance / LAMPORTS_PER_SOL).toFixed(4) + ' SOL',
    rpcEndpoint: rpc.rpcEndpoint,
    commitment: CONSTANTS.CONNECTION_COMMITMENT,
    timestamp: new Date().toISOString()
  });
};