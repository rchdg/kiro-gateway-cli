#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(pkg.version);
if (!match) {
  throw new Error(`Cannot parse version: ${pkg.version}`);
}

const [, major, minor, , suffix] = match;
const nextVersion = `${major}.${Number(minor) + 1}.0${suffix || ''}`;

pkg.version = nextVersion;
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

console.log(`Bumped version to ${nextVersion}`);
