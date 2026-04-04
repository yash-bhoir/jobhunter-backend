const { v4: uuid } = require('uuid');

const normalize = (job) => ({
  externalId:  job.externalId  || job.id         || job.job_id    || uuid(),
  title:       job.title       || job.position    || job.job_title || job.name || '',
  company:     job.company     || job.company_name|| job.employer_name        || '',
  location:    job.location    || job.job_city    || job.jobGeo                || '',
  description: (job.description|| job.job_description || job.contents || job.jobExcerpt || '')
                 .replace(/<[^>]*>/g, '').substring(0, 3000),
  url:         job.url         || job.job_apply_link || job.redirect_url       || '',
  salary:      job.salary      || job.salaryRange ||
               (job.job_min_salary ? `${job.job_min_salary} - ${job.job_max_salary}` : 'Not specified'),
  source:      job.source      || '',
  remote:      job.remote      || job.job_is_remote || false,
  postedAt:    job.postedAt    || job.job_posted_at_datetime_utc || null,
});

module.exports = { normalize };