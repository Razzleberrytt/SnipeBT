'use strict';

class Telegraf {
  constructor(token) {
    this.token = token;
    this.commands = new Map();
  }

  command(name, handler) {
    this.commands.set(name, handler);
  }

  launch() {
    // Stub does not connect to Telegram. It merely logs launch.
    if (process?.env?.NODE_ENV !== 'test') {
      console.log('Telegraf stub launch for token', this.token ? '[hidden]' : '[missing]');
    }
  }

  stop() {
    // no-op
  }
}

module.exports = { Telegraf };
