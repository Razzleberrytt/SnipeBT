#!/usr/bin/env node
'use strict';

const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

async function main() {
  const rootDir = process.cwd();
  const vendorDir = path.join(rootDir, 'vendor', 'npm');
  const manifestPath = path.join(vendorDir, 'manifest.json');

  if (!(await exists(manifestPath))) {
    console.error('Missing vendor/npm/manifest.json. Run "npm run pack:tarballs" on an online machine first.');
    process.exit(1);
  }

  const manifestRaw = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestRaw);
  if (!Array.isArray(manifest) || manifest.length === 0) {
    console.error('vendor/npm/manifest.json does not contain any packages to install.');
    process.exit(1);
  }

  const nodeModulesDir = path.join(rootDir, 'node_modules');
  await fs.rm(nodeModulesDir, { recursive: true, force: true });
  await fs.mkdir(nodeModulesDir, { recursive: true });

  const sortedManifest = [...manifest].sort((a, b) => a.path.length - b.path.length);

  for (const entry of sortedManifest) {
    const tarballPath = path.join(vendorDir, entry.filename);
    if (!(await exists(tarballPath))) {
      throw new Error(`Missing tarball for ${entry.name} at ${tarballPath}`);
    }
    const installPath = path.join(rootDir, entry.path);
    await extractTarball(tarballPath, installPath);
  }

  console.log(`Installed ${manifest.length} packages into node_modules from offline tarballs.`);
}

async function extractTarball(tarballPath, installPath) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snipebt-offline-'));
  try {
    await runTar(['-xzf', tarballPath, '-C', tmpDir]);
    const packageDir = path.join(tmpDir, 'package');
    if (!(await exists(packageDir))) {
      throw new Error(`Tarball ${tarballPath} did not contain a package directory.`);
    }

    await fs.rm(installPath, { recursive: true, force: true });
    await fs.mkdir(path.dirname(installPath), { recursive: true });
    await copyDir(packageDir, installPath);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      const linkTarget = await fs.readlink(srcPath);
      await fs.symlink(linkTarget, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function runTar(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('tar', args, { stdio: ['ignore', 'inherit', 'inherit'] });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`tar exited with code ${code}`));
      } else {
        resolve();
      }
    });
  });
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
