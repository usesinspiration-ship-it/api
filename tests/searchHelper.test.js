const assert = require('node:assert/strict');
const { __private } = require('../utils/searchHelper');

function run() {
  const parsedBoolean = __private.parseBooleanQuery('Python AND React NOT Java');
  assert.deepEqual(parsedBoolean.requiredTerms, ['python', 'react']);
  assert.deepEqual(parsedBoolean.excludedTerms, ['java']);

  const parsedPagination = __private.parsePagination({ limit: '20', page: '3' });
  assert.equal(parsedPagination.limit, 20);
  assert.equal(parsedPagination.skip, 40);
  assert.equal(parsedPagination.page, 3);

  const canonical = __private.canonicalizeTerm('pythno');
  assert.equal(canonical, 'python');

  const fuzzyExpanded = __private.expandFuzzyTerms('aws');
  assert.ok(fuzzyExpanded.includes('aws'));
  assert.ok(fuzzyExpanded.includes('amazon web services'));

  const parsedRequest = __private.parseSearchRequest({
    q: 'JavaScript',
    skill: ['React', 'nodejs'],
    title: 'Developer',
    minExperience: '3',
    maxExperience: '9',
    education: 'Bachelor,Master',
    languages: 'English,Spanish',
    limit: '30',
    skip: '30',
    sort: 'relevance',
    order: 'desc',
  });

  assert.equal(parsedRequest.limit, 30);
  assert.equal(parsedRequest.skip, 30);
  assert.deepEqual(parsedRequest.skillFilters, ['react', 'node.js']);
  assert.deepEqual(parsedRequest.educationFilters, ['bachelor', 'master']);
  assert.deepEqual(parsedRequest.languageFilters, ['english', 'spanish']);
  assert.equal(parsedRequest.minExperience, 3);
  assert.equal(parsedRequest.maxExperience, 9);

  console.log('All searchHelper tests passed.');
}

try {
  run();
} catch (error) {
  console.error('searchHelper tests failed:', error);
  process.exit(1);
}
