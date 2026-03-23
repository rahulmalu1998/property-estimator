#!/usr/bin/env node
/**
 * Smoke test: service account → Earth Engine API (ee.Number.getInfo).
 * Run: node earth-engine/verify-connection.js
 */

const { initializeEarthEngine } = require('./client');

initializeEarthEngine()
  .then((ee) => {
    return new Promise((resolve, reject) => {
      // EE client uses (value, error?), not Node (err, value).
      ee.Number(42).getInfo((value, err) => {
        if (err) reject(new Error(err));
        else resolve(value);
      });
    });
  })
  .then((value) => {
    console.log('Earth Engine API OK. ee.Number(42).getInfo() =>', value);
    process.exit(0);
  })
  .catch((err) => {
    console.error('Earth Engine connection failed:', err.message || err);
    if (String(err.message || err).includes('not registered')) {
      console.error(
        '\nHint: Register the Cloud project and service account for Earth Engine:\n' +
          'https://developers.google.com/earth-engine/guides/service_account'
      );
    }
    process.exit(1);
  });
