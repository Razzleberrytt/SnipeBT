import type Keytar from 'keytar';

import { getConfig } from '../config';

export interface SecretsProvider {
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<boolean>;
  listKeys(): Promise<string[]>;
}

class KeytarSecretsProvider implements SecretsProvider {
  private keytarPromise: Promise<typeof Keytar>;

  constructor(private readonly service: string, private readonly defaultAccount?: string) {
    this.keytarPromise = import('keytar');
  }

  private buildAccount(key: string): string {
    return this.defaultAccount ? `${this.defaultAccount}:${key}` : key;
  }

  async getSecret(key: string): Promise<string | null> {
    const keytar = await this.keytarPromise;
    return keytar.getPassword(this.service, this.buildAccount(key));
  }

  async setSecret(key: string, value: string): Promise<void> {
    const keytar = await this.keytarPromise;
    await keytar.setPassword(this.service, this.buildAccount(key), value);
  }

  async deleteSecret(key: string): Promise<boolean> {
    const keytar = await this.keytarPromise;
    return keytar.deletePassword(this.service, this.buildAccount(key));
  }

  async listKeys(): Promise<string[]> {
    const keytar = await this.keytarPromise;
    const credentials = await keytar.findCredentials(this.service);
    return credentials.map((cred) => cred.account);
  }
}

class VaultSecretsProvider implements SecretsProvider {
  constructor(_service?: string, _account?: string) {}

  async getSecret(key: string): Promise<string | null> {
    throw new Error(
      `HashiCorp Vault provider is not configured. Set SECRET_PROVIDER=local or implement Vault integration (missing secret: ${key}).`
    );
  }

  async setSecret(key: string, _value: string): Promise<void> {
    throw new Error(
      `HashiCorp Vault provider is not implemented. Unable to set secret ${key}.`
    );
  }

  async deleteSecret(key: string): Promise<boolean> {
    throw new Error(
      `HashiCorp Vault provider is not implemented. Unable to delete secret ${key}.`
    );
  }

  async listKeys(): Promise<string[]> {
    throw new Error('HashiCorp Vault provider does not support listing secrets via CLI yet.');
  }
}

class OnePasswordSecretsProvider implements SecretsProvider {
  constructor(_service?: string, _account?: string) {}

  async getSecret(key: string): Promise<string | null> {
    throw new Error(
      `1Password provider is not configured. Set SECRET_PROVIDER=local or implement 1Password integration (missing secret: ${key}).`
    );
  }

  async setSecret(key: string, _value: string): Promise<void> {
    throw new Error(`1Password provider is not implemented. Unable to set secret ${key}.`);
  }

  async deleteSecret(key: string): Promise<boolean> {
    throw new Error(`1Password provider is not implemented. Unable to delete secret ${key}.`);
  }

  async listKeys(): Promise<string[]> {
    throw new Error('1Password provider does not support listing secrets via CLI yet.');
  }
}

interface SecretsProviderOptions {
  service?: string;
  accountPrefix?: string;
}

export function createSecretsProvider(options: SecretsProviderOptions = {}): SecretsProvider {
  const { secrets } = getConfig();

  switch (secrets.provider) {
    case 'local': {
      const service = options.service ?? secrets.service ?? 'snipebt';
      const accountPrefix = options.accountPrefix ?? secrets.account;
      return new KeytarSecretsProvider(service, accountPrefix);
    }
    case 'vault':
      return new VaultSecretsProvider(secrets.service, secrets.account);
    case '1password':
      return new OnePasswordSecretsProvider(secrets.service, secrets.account);
    default:
      throw new Error(`Unsupported secret provider configured: ${secrets.provider}`);
  }
}
