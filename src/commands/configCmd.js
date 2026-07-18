const config = require('../config');

function set(key, value) {
  config.set(key, value);
  console.log(`Config "${key}" set to "${value}"`);
}

function list() {
  const all = config.all();
  console.log('Current Configuration');
  console.log('----------------------');
  for (const [key, value] of Object.entries(all)) {
    console.log(`${key} = ${value}`);
  }
}

module.exports = { set, list };
