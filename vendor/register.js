'use strict';

const path = require('path');
const Module = require('module');

const vendorPath = path.resolve(__dirname);
const existing = process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : [];
if (!existing.includes(vendorPath)) {
  existing.unshift(vendorPath);
  process.env.NODE_PATH = existing.join(path.delimiter);
  Module._initPaths();
}
