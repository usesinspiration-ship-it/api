const assert = require('node:assert/strict');
const { __private } = require('../utils/statsHelper');

function run() {
  assert.equal(__private.formatBytes(0), '0 B');
  assert.equal(__private.formatBytes(1024), '1.0 KB');
  assert.equal(__private.formatBytes(1024 * 1024), '1.0 MB');

  assert.equal(__private.classifyEducation('PhD in Computer Science'), 'PhD');
  assert.equal(__private.classifyEducation('Master of Science'), 'Master');
  assert.equal(__private.classifyEducation('B.Tech in IT'), 'Bachelor');
  assert.equal(__private.classifyEducation('Diploma in Design'), 'Diploma');
  assert.equal(__private.classifyEducation(''), 'Unknown');

  const trend = __private.buildTrendBuckets([
    { day: new Date().toISOString().slice(0, 10), count: 4 },
  ], 3);
  assert.equal(trend.labels.length, 3);
  assert.equal(trend.data.length, 3);
  assert.equal(trend.data[2], 4);

  console.log('All statsHelper tests passed.');
}

try {
  run();
} catch (error) {
  console.error('statsHelper tests failed:', error);
  process.exit(1);
}
