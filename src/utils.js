function requireEnv(name, defaultValue) {
  if (typeof process.env[name] === 'undefined') {
    if (typeof defaultValue !== 'undefined') {
      return defaultValue;
    } else {
      throw new Error(`Missing required environment variable: ` + name);
    }
  }
  return process.env[name];
}

module.exports = { requireEnv };
