const axios  = require('axios');
const logger = require('../../config/logger');

/**
 * Fetch all open jobs for a company using Ashby's public GraphQL API.
 * Used by OpenAI, Mistral, ElevenLabs, Perplexity, etc.
 */
const fetchAshby = async ({ name, slug }) => {
  try {
    const { data } = await axios.post(
      'https://jobs.ashbyhq.com/api/non-user-graphql',
      {
        operationName: 'ApiJobBoardWithTeams',
        variables:     { organizationHostedJobsPageName: slug },
        query: `
          query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!) {
            jobBoard: jobBoardWithTeams(organizationHostedJobsPageName: $organizationHostedJobsPageName) {
              jobPostings {
                id title isRemote
                locationName
                employmentType
                publishedDate
                externalLink
                descriptionHtml
              }
            }
          }
        `,
      },
      {
        timeout: 10000,
        headers: { 'Content-Type': 'application/json' },
      }
    );

    const postings = data?.data?.jobBoard?.jobPostings || [];

    return postings.map(j => ({
      id:          `ashby_${slug}_${j.id}`,
      title:       j.title        || '',
      company:     name,
      location:    j.locationName || (j.isRemote ? 'Remote' : 'On-site'),
      url:         j.externalLink || `https://jobs.ashbyhq.com/${slug}/${j.id}`,
      description: j.descriptionHtml?.replace(/<[^>]+>/g, ' ') || '',
      remote:      !!j.isRemote,
      postedAt:    j.publishedDate ? new Date(j.publishedDate) : new Date(),
      source:      'career_page',
      platform:    'ashby',
      boardKey:    `ashby:${slug}`,
    }));
  } catch (err) {
    if (err.response?.status === 404) return [];
    logger.warn(`Ashby fetch failed for ${name}: ${err.message}`);
    return [];
  }
};

module.exports = { fetchAshby };
