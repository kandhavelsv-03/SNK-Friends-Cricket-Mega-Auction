'use strict';
// Vercel serverless entrypoint. The Express app is exported without opening a local TCP listener.
module.exports = require('../server').app;
