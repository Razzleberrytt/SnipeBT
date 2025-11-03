'use strict';

const registryCounters = new Map();

class Counter {
  constructor(opts) {
    this.name = opts?.name ?? 'counter';
    this.help = opts?.help ?? '';
    this.value = 0;
    registryCounters.set(this.name, this);
  }

  inc(val = 1) {
    const amount = typeof val === 'number' ? val : Number(val?.value ?? 1);
    if (!Number.isFinite(amount)) return;
    this.value += amount;
  }

  get() {
    return { name: this.name, help: this.help, value: this.value };
  }
}

function collectDefaultMetrics() {
  // no-op in stub
}

const register = {
  contentType: 'text/plain; version=0.0.4',
  async metrics() {
    const lines = [];
    for (const counter of registryCounters.values()) {
      lines.push(`# HELP ${counter.name} ${counter.help}`.trim());
      lines.push(`# TYPE ${counter.name} counter`);
      lines.push(`${counter.name} ${counter.value}`);
    }
    return lines.join('\n') + '\n';
  }
};

module.exports = {
  Counter,
  collectDefaultMetrics,
  register,
  default: { Counter, collectDefaultMetrics, register }
};
