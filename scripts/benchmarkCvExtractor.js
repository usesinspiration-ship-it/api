const { performance } = require('node:perf_hooks');
const { extractCVFields } = require('../utils/cvExtractor');

function buildSyntheticCV(sizeInMb) {
  const block = `
John Doe\nSenior Software Engineer\nEmail: john.doe@example.com\nPhone: +1 (555) 123-4567\nLinkedIn: https://linkedin.com/in/john-doe\nGitHub: https://github.com/johndoe\n8+ years of experience\nSkills: JavaScript React Node.js Express MySQL PostgreSQL Docker AWS Git GraphQL Linux Leadership Communication Project Management\nBachelor of Science in Computer Science - University of California Graduation 2016\nLanguages: English (Fluent), Spanish (Intermediate)\nAWS Certified Solutions Architect\n`;

  const targetBytes = sizeInMb * 1024 * 1024;
  let result = '';
  while (Buffer.byteLength(result, 'utf8') < targetBytes) {
    result += block;
  }
  return result;
}

async function runBenchmark() {
  const cases = [1, 5, 10];

  for (const mb of cases) {
    const sample = buildSyntheticCV(mb);

    const t0 = performance.now();
    const extracted = await extractCVFields(sample);
    const t1 = performance.now();

    console.log(
      JSON.stringify(
        {
          sizeMB: mb,
          durationMs: Number((t1 - t0).toFixed(2)),
          detectedSkills: extracted.skills.length,
          detectedJobTitles: extracted.jobTitles.length,
          email: extracted.email,
          experience: extracted.experience,
        },
        null,
        2
      )
    );
  }
}

runBenchmark().catch((error) => {
  console.error('Benchmark failed:', error);
  process.exit(1);
});
