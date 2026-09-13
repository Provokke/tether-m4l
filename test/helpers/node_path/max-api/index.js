'use strict';

const handlers = new Map();

process.on('message', ({ selector, atoms }) => {
  const fn = handlers.get(selector);
  if (fn) fn(...atoms);
});

module.exports = {
  POST_LEVELS: { ERROR: 'error', INFO: 'info', WARN: 'warn' },
  addHandler(selector, fn) {
    handlers.set(selector, fn);
  },
  post(...args) {
    process.send({ kind: 'post', args });
  },
  outlet(...atoms) {
    process.send({ kind: 'outlet', atoms });
    return Promise.resolve();
  },
};
