'use strict';

// Promisified child_process.exec shared by the service modules.
//
// Status/dependency probes run on a timer and must NOT block the Electron main
// thread — synchronous execSync calls freeze the event loop and trigger the
// macOS spinning-wait cursor. This resolves { stdout, stderr } or rejects on a
// non-zero exit, which is exactly what the boolean "is it running?" probes need.
const { exec } = require('child_process');
const { promisify } = require('util');

module.exports = promisify(exec);
