const extractDomain = (company) => {
  return company
    .toLowerCase()
    .replace(/\s+(inc|ltd|llc|pvt|technologies|tech|solutions|systems|software|services|group|co|corp|limited)\.?$/gi, '')
    .replace(/[^a-z0-9]/g, '') + '.com';
};

const generate = (domain, company) => ({
  domain,
  emails: [
    { email: `hr@${domain}`,       name: 'HR Team',      confidence: 30, source: 'pattern', status: 'predicted' },
    { email: `careers@${domain}`,  name: 'Careers',      confidence: 30, source: 'pattern', status: 'predicted' },
    { email: `talent@${domain}`,   name: 'Talent Team',  confidence: 25, source: 'pattern', status: 'predicted' },
    { email: `hiring@${domain}`,   name: 'Hiring Team',  confidence: 25, source: 'pattern', status: 'predicted' },
    { email: `recruit@${domain}`,  name: 'Recruitment',  confidence: 20, source: 'pattern', status: 'predicted' },
    { email: `jobs@${domain}`,     name: 'Jobs',         confidence: 20, source: 'pattern', status: 'predicted' },
  ],
  careerPageUrl:  `https://${domain}/careers`,
  linkedinUrl:    `https://linkedin.com/company/${company.toLowerCase().replace(/\s+/g, '-')}`,
  employeeSearch: `https://linkedin.com/search/results/people/?keywords=${encodeURIComponent(company)}%20HR%20Recruiter`,
});

module.exports = { extractDomain, generate };
