const axios = require('axios');

// Lever ATS — direct job listings from top startups & scale-ups
// Completely FREE — no API key required (public posting API)
// Covers: Figma, Vercel, Notion, Linear, Loom, Zapier, Airtable, etc.

const COMPANIES = [
  'figma', 'vercel', 'notion', 'linear', 'loom', 'zapier',
  'airtable', 'amplitude', 'retool', 'pitch', 'descript',
  'deel', 'remote', 'mercury', 'causal', 'cord', 'pipe',
  'replit', 'codeium', 'perplexity', 'mistral', 'cohere',
  'weights-biases', 'modal', 'fly',
];

const fetchCompany = async (company, roleKeyword) => {
  try {
    const { data } = await axios.get(
      `https://api.lever.co/v0/postings/${company}`,
      { params: { mode: 'json', limit: 50 }, timeout: 8000 }
    );

    const kw = (roleKeyword || '').toLowerCase();
    return (Array.isArray(data) ? data : [])
      .filter(j => !kw || (j.text || '').toLowerCase().includes(kw))
      .map(j => ({
        externalId:  j.id              || '',
        title:       j.text            || '',
        company:     company.charAt(0).toUpperCase() + company.slice(1).replace(/-/g, ' '),
        location:    j.categories?.location || j.workplaceType || 'Remote',
        description: (j.descriptionPlain || '').substring(0, 3000),
        url:         j.hostedUrl       || '',
        salary:      j.salaryRange
                       ? `${j.salaryRange.min || ''} - ${j.salaryRange.max || ''} ${j.salaryRange.currency || ''}`
                       : 'Not specified',
        source:      'Lever',
        remote:      (j.workplaceType  || '').toLowerCase().includes('remote') ||
                     (j.categories?.location || '').toLowerCase().includes('remote'),
        postedAt:    j.createdAt ? new Date(j.createdAt).toISOString() : null,
      }));
  } catch {
    return [];
  }
};

const search = async ({ role }) => {
  const batches = [];
  for (let i = 0; i < COMPANIES.length; i += 6) {
    const batch = COMPANIES.slice(i, i + 6);
    const results = await Promise.all(batch.map(c => fetchCompany(c, role)));
    batches.push(...results.flat());
  }
  return batches;
};

module.exports = { search };
