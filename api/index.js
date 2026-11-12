'use strict';
const { app, ready } = require('../server');
// Ensure Atlas connection and indexes are ready before serving the first request.
module.exports = async (req, res) => {
  try {
    await ready;
    return app(req, res);
  } catch (error) {
    console.error('MongoDB startup failed:', error);
    return res.status(500).json({ ok: false, error: 'Database connection failed' });
  }
};
