const assert = require('node:assert/strict');
const { extractCVFields } = require('../utils/cvExtractor');

async function run() {
  const sample1 = `
John Doe
Senior Software Engineer / Tech Lead
Email: john.doe@example.com
Phone: +1 (555) 123-4567
LinkedIn: https://www.linkedin.com/in/johndoe
GitHub: https://github.com/johndoe
Address: 123 Main Street, San Francisco, CA 94105

Summary:
8+ years of experience building scalable web platforms.
Skills: JavaScript, React, Node.js, Express, MySQL, PostgreSQL, Docker, AWS, Git, REST API, Leadership, Communication.

Experience:
2017 - Present: Senior Developer at Example Corp
2014 - 2017: Software Engineer at Previous Inc

Education:
Bachelor of Science in Computer Science, Stanford University, Graduation 2014

Languages: English (Fluent), Spanish (Intermediate)
Certifications: AWS Certified Solutions Architect, Google Certified Professional Cloud Architect
Awards: Winner - Hackathon 2019
Publication: Research paper on API optimization
  `;

  const sample2 = `
Maria Gomez
Product Manager
Email: maria.gomez@company.org
Phone: 555.123.4567
Portfolio: www.mariagomez.dev

Profile
3 years experience in product management and analytics.
Skills include SQL, Python, Analytical Thinking, Project Management, Team Management.

Education
MBA in Business Administration - University of Chicago (2022)
Languages: English, Portuguese
  `;

  const sample3 = `
Incomplete CV text
No contacts here
Worked with teams and solved problems.
secondary school finished in 2010.
  `;

  const r1 = await extractCVFields(sample1);
  assert.equal(r1.email, 'john.doe@example.com');
  assert.ok(r1.phone && r1.phone.includes('555'));
  assert.ok(r1.jobTitles.includes('Software Engineer') || r1.jobTitles.includes('Developer'));
  assert.ok(r1.skills.includes('JavaScript'));
  assert.ok(r1.skills.includes('Leadership'));
  assert.equal(r1.experience, '8+ years');
  assert.ok(r1.languages.includes('English'));
  assert.ok(r1.certifications.some((c) => /aws certified/i.test(c)));
  assert.ok(r1.github.some((g) => /github\.com\/johndoe/i.test(g)));
  assert.equal(r1.scored.email.value, 'john.doe@example.com');
  assert.ok(r1.scored.skills.confidence > 0);

  const r2 = await extractCVFields(sample2);
  assert.equal(r2.email, 'maria.gomez@company.org');
  assert.ok(r2.skills.includes('SQL'));
  assert.ok(r2.skills.includes('Project Management'));
  assert.ok(r2.education && /Master's|MBA/i.test(r2.education));
  assert.ok(r2.languages.includes('Portuguese'));

  const r3 = await extractCVFields(sample3);
  assert.equal(r3.email, null);
  assert.equal(r3.phone, null);
  assert.ok(Array.isArray(r3.skills));
  assert.ok(r3.confidence.education >= 0);
  assert.equal(r3.scored.email.value, null);

  console.log('All cvExtractor tests passed.');
}

run().catch((error) => {
  console.error('cvExtractor tests failed:', error);
  process.exit(1);
});
