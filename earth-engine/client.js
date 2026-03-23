/**
 * Initialize the Earth Engine client with a GCP service account JSON key.
 *
 * Prerequisites (Google Cloud / Earth Engine):
 * - The Cloud project must be registered for Earth Engine.
 * - This service account email must be added as an EE user for that project.
 *
 * Set GOOGLE_APPLICATION_CREDENTIALS to the absolute path of your key file, e.g.:
 *   export GOOGLE_APPLICATION_CREDENTIALS="/path/to/key.json"
 */

const fs = require('fs');
const path = require('path');
const ee = require('@google/earthengine');

function loadCredentials() {
  const p =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    path.join(__dirname, '..', 'lateral-booster-279114-9dde8dbf2bc4.json');
  if (!fs.existsSync(p)) {
    throw new Error(
      `Earth Engine credentials file not found: ${p}\n` +
        'Set GOOGLE_APPLICATION_CREDENTIALS to your service account JSON path.'
    );
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * @param {{ projectId?: string }} [opts] — optional EE project override
 * @returns {Promise<typeof ee>}
 */
function initializeEarthEngine(opts = {}) {
  const credentials = loadCredentials();
  const projectId = opts.projectId ?? credentials.project_id;

  return new Promise((resolve, reject) => {
    ee.data.authenticateViaPrivateKey(
      credentials,
      () => {
        ee.initialize(
          null,
          null,
          () => resolve(ee),
          (err) => reject(err),
          null,
          projectId
        );
      },
      (err) => reject(err)
    );
  });
}

module.exports = { ee, initializeEarthEngine, loadCredentials };
