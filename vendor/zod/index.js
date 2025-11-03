'use strict';

class ZodError extends Error {
  constructor(issues) {
    super('Invalid input');
    this.issues = issues;
  }

  format() {
    const result = {};
    for (const issue of this.issues) {
      const pathKey = issue.path?.[0] ?? '_root';
      if (!result[pathKey]) {
        result[pathKey] = { _errors: [] };
      }
      result[pathKey]._errors.push(issue.message);
    }
    return result;
  }
}

class BaseSchema {
  constructor() {
    this._isOptional = false;
    this._hasDefault = false;
    this._defaultValue = undefined;
  }

  optional() {
    this._isOptional = true;
    return this;
  }

  default(value) {
    this._hasDefault = true;
    this._defaultValue = value;
    return this;
  }

  _getValue(value) {
    if (value === undefined || value === null) {
      if (this._hasDefault) return this._defaultValue;
      if (this._isOptional) return undefined;
      throw new ZodError([{ path: [], message: 'Required' }]);
    }
    return value;
  }

  parse(value) {
    const prepared = this._getValue(value);
    return this._parse(prepared);
  }

  _parse(value) {
    return value;
  }

  safeParse(value) {
    try {
      const data = this.parse(value);
      return { success: true, data };
    } catch (err) {
      if (err instanceof ZodError) {
        return { success: false, error: err };
      }
      return { success: false, error: new ZodError([{ path: [], message: err?.message ?? 'Unknown error' }]) };
    }
  }
}

class StringSchema extends BaseSchema {
  constructor() {
    super();
    this._checks = [];
  }

  url() {
    this._checks.push((value) => {
      try {
        new URL(value);
        return true;
      } catch {
        throw new ZodError([{ path: [], message: 'Invalid url' }]);
      }
    });
    return this;
  }

  _parse(value) {
    if (value === undefined && this._isOptional) return undefined;
    if (typeof value !== 'string') {
      throw new ZodError([{ path: [], message: 'Expected string' }]);
    }
    for (const check of this._checks) check(value);
    return value;
  }
}

class NumberSchema extends BaseSchema {
  constructor() {
    super();
    this._checks = [];
  }

  int() {
    this._checks.push((value) => {
      if (!Number.isInteger(value)) {
        throw new ZodError([{ path: [], message: 'Expected integer' }]);
      }
    });
    return this;
  }

  min(minValue) {
    this._checks.push((value) => {
      if (value < minValue) {
        throw new ZodError([{ path: [], message: `Expected >= ${minValue}` }]);
      }
    });
    return this;
  }

  max(maxValue) {
    this._checks.push((value) => {
      if (value > maxValue) {
        throw new ZodError([{ path: [], message: `Expected <= ${maxValue}` }]);
      }
    });
    return this;
  }

  _parse(value) {
    if (value === undefined && this._isOptional) return undefined;
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new ZodError([{ path: [], message: 'Expected number' }]);
    }
    for (const check of this._checks) check(value);
    return value;
  }
}

class BooleanSchema extends BaseSchema {
  _parse(value) {
    if (value === undefined && this._isOptional) return undefined;
    if (typeof value !== 'boolean') {
      throw new ZodError([{ path: [], message: 'Expected boolean' }]);
    }
    return value;
  }
}

class EnumSchema extends BaseSchema {
  constructor(values) {
    super();
    this._values = values;
  }

  _parse(value) {
    if (!this._values.includes(value)) {
      throw new ZodError([{ path: [], message: 'Invalid enum value' }]);
    }
    return value;
  }
}

class ObjectSchema extends BaseSchema {
  constructor(shape) {
    super();
    this.shape = shape;
  }

  _parse(value) {
    if (typeof value !== 'object' || value === null) {
      throw new ZodError([{ path: [], message: 'Expected object' }]);
    }
    const output = {};
    const issues = [];
    for (const [key, schema] of Object.entries(this.shape)) {
      try {
        output[key] = schema.parse(value[key]);
      } catch (err) {
        if (err instanceof ZodError) {
          issues.push(...err.issues.map((issue) => ({ path: [key, ...issue.path], message: issue.message })));
        } else {
          issues.push({ path: [key], message: err?.message ?? 'Invalid value' });
        }
      }
    }
    if (issues.length > 0) {
      throw new ZodError(issues);
    }
    return output;
  }
}

class NumberCoerceSchema extends NumberSchema {
  parse(value) {
    const coerced = value === undefined || value === null ? value : Number(value);
    return super.parse(coerced);
  }
}

class BooleanCoerceSchema extends BooleanSchema {
  parse(value) {
    if (value === undefined || value === null) {
      return super.parse(value);
    }
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
      if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    }
    if (typeof value === 'number') {
      return Boolean(value);
    }
    return super.parse(value);
  }
}

const z = {
  object(shape) {
    return new ObjectSchema(shape);
  },
  string() {
    return new StringSchema();
  },
  enum(values) {
    return new EnumSchema(values);
  },
  coerce: {
    number() {
      return new NumberCoerceSchema();
    },
    boolean() {
      return new BooleanCoerceSchema();
    }
  }
};

z.number = function number() {
  return new NumberSchema();
};

z.boolean = function boolean() {
  return new BooleanSchema();
};

z.infer = () => {
  throw new Error('z.infer is a TypeScript-only helper in this stub implementation.');
};

module.exports = { z, ZodError };
module.exports.default = z;
