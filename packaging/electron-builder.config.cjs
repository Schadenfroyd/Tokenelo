'use strict';

const fs = require('node:fs');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '..');
const lock = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package-lock.json'), 'utf8'));
const electronVersion = lock.packages?.['node_modules/electron']?.version;
const packageVersion = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')).version;
if (typeof electronVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(electronVersion)) {
  throw new Error('The locked Electron runtime version is missing or invalid');
}

if (typeof packageVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(packageVersion)) {
  throw new Error('The product version is missing or invalid');
}

module.exports = {
  appId: 'com.elostudios.tokenelo',
  productName: 'Tokenelo',
  buildVersion: packageVersion,
  // AppInfo reads product-version build numbers separately from buildVersion.
  buildNumber: '0',
  copyright: 'Copyright © 2026 Elo AI',
  electronVersion,
  directories: { output: '../artifacts' },
  files: [
    'package.json',
    { from: 'dist', to: 'dist', filter: ['**/*'] },
    { from: 'rates', to: 'rates', filter: ['**/*'] },
    'scripts/install-service-windows.ps1',
    'scripts/install-service-macos.sh',
    'scripts/windows/TokeneloHiddenLauncher.cs',
  ],
  // Keep compiled entrypoints and data as ordinary files for Electron-as-Node child launches.
  // The first unpacked-directory acceptance must qualify this path before an archive is considered.
  asar: false,
  // The private stage has no production dependencies; never install or rebuild at package time.
  npmRebuild: false,
  // Keep product metadata/resource editing, but never discover or apply a signing identity.
  win: {
    target: ['nsis'],
    signExecutable: false,
    requestedExecutionLevel: 'asInvoker',
    icon: path.join(repositoryRoot, 'packaging', 'icons', 'generated', 'tokenelo-windows.ico'),
  },
  mac: { icon: path.join(repositoryRoot, 'packaging', 'icons', 'generated', 'tokenelo-macos.icns') },
  linux: { icon: path.join(repositoryRoot, 'packaging', 'icons', 'generated', 'tokenelo-linux-512.png') },
  nsis: {
    include: path.join(repositoryRoot, 'scripts', 'windows', 'tokenelo-uninstall.nsh'),
    oneClick: true,
    perMachine: false,
    allowElevation: false,
    packElevateHelper: false,
    runAfterFinish: false,
    deleteAppDataOnUninstall: false,
    createDesktopShortcut: false,
  },
  // No feed/provider or updater is configured. Keep the v26 implicit publisher disabled too.
  publish: null,
};
