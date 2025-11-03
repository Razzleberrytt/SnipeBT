'use strict';

const fetchImpl = (...args) => {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('Global fetch is not available in this runtime.');
  }
  return globalThis.fetch(...args);
};

module.exports = fetchImpl;
module.exports.default = fetchImpl;
module.exports.Headers = globalThis.Headers;
module.exports.Request = globalThis.Request;
module.exports.Response = globalThis.Response;
