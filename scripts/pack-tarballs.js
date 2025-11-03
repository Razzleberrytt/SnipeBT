#!/usr/bin/env node
'use strict';

const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

async function main() {
  const rootDir = process.cwd();
  const nodeModulesDir = path.join(rootDir, 'node_modules');
  if (!(await exists(nodeModulesDir))) {
    console.error('Cannot find node_modules/. Run "npm ci" before packing tarballs.');
    process.exit(1);
  }

  const lockPath = path.join(rootDir, 'package-lock.json');
  const lockRaw = await fs.readFile(lockPath, 'utf8');
  const lock = JSON.parse(lockRaw);
  const packages = lock.packages || {};
  const packageEntries = Object.entries(packages)
    .filter(([key]) => key && key.startsWith('node_modules/'))
    .sort(([a], [b]) => a.localeCompare(b));

  if (packageEntries.length === 0) {
    console.error('package-lock.json does not contain any installed packages. Run "npm ci" first.');
    process.exit(1);
  }

  const vendorDir = path.join(rootDir, 'vendor', 'npm');
  await fs.rm(vendorDir, { recursive: true, force: true });
  await fs.mkdir(vendorDir, { recursive: true });

  const manifest = [];

  for (const [pkgPath, pkgInfo] of packageEntries) {
    const absModulePath = path.join(rootDir, pkgPath);
    if (!(await exists(absModulePath))) {
      console.warn(`Skipping ${pkgPath} because directory is missing.`);
      continue;
    }

    const packResult = await npmPack(absModulePath, vendorDir);
    if (!packResult) {
      console.warn(`Failed to pack ${pkgPath}`);
      continue;
    }

    const pkgJsonPath = path.join(absModulePath, 'package.json');
    let pkgJson;
    try {
      const pkgJsonRaw = await fs.readFile(pkgJsonPath, 'utf8');
      pkgJson = JSON.parse(pkgJsonRaw);
    } catch {
      pkgJson = { name: pkgInfo.name || path.basename(pkgPath) };
    }

    manifest.push({
      path: pkgPath,
      name: pkgJson.name,
      version: pkgInfo.version || pkgJson.version,
      filename: packResult.filename
    });
  }

  if (manifest.length === 0) {
    console.error('No tarballs were produced. Ensure dependencies are installed before running pack:tarballs.');
    process.exit(1);
  }

  const manifestPath = path.join(vendorDir, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Packed ${manifest.length} tarballs into vendor/npm/`);
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function npmPack(modulePath, destination) {
  return new Promise((resolve, reject) => {
    const proc = spawn('npm', ['pack', modulePath, '--pack-destination', destination, '--json'], {
      stdio: ['ignore', 'pipe', 'inherit']
    });
    let stdout = '';
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code !== 0) {
        return resolve(null);
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        if (Array.isArray(parsed)) {
          resolve(parsed[0]);
        } else {
          resolve(parsed);
        }
      } catch (err) {
        reject(new Error(`Failed to parse npm pack output for ${modulePath}: ${err.message}`));
      }
    });
  });
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
