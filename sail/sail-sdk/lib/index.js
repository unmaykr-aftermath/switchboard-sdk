const neon = require("../native");
module.exports = { ...neon };
module.exports.default = module.exports;

// Examples
//   console.log(new TeeRandomness().readRand(10));
