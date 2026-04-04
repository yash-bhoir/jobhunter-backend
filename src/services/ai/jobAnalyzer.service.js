const OpenAI  = require('openai');
const crypto  = require('crypto');
const logger  = require('../../config/logger');

const getClient = () => new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Cache helpers ─────────────────────────────────────────────────
let _cache = null;
const getCache = () => {
  if (!_cache) { try { _cache = require('../../config/redis').cache; } catch { _cache = null; } }
  return _cache;
};
const cacheGet = async (k)        => { try { return await getCache()?.get(k); } catch { return null; } };
const cacheSet = async (k, v, ttl) => { try { await getCache()?.set(k, v, ttl); } catch {} };

// ── Explain job match score ───────────────────────────────────────
// Cache: MD5(jobId + userId) — TTL 24h. Same job+user = same analysis.
const explainMatch = async ({ job, user }) => {
  const ck     = `ai:match:${crypto.createHash('md5').update(`${job._id}${user._id}`).digest('hex')}`;
  const cached = await cacheGet(ck);
  if (cached) { logger.info('[JobAnalyzer] explainMatch cache hit'); return cached; }

  if (!process.env.OPENAI_API_KEY) return generateFallbackExplanation({ job, user });

  const client = getClient();
  const p      = user.profile || {};
  const skills = [...(p.skills || []), ...(user.resume?.extractedSkills || [])];

  const prompt = `Analyze why this job matches this candidate and give actionable feedback.

Candidate:
- Current role: ${p.currentRole || 'Not specified'}
- Target role: ${p.targetRole || 'Not specified'}
- Experience: ${p.experience || 0} years
- Skills: ${skills.join(', ') || 'None listed'}
- Work preference: ${p.workType || 'any'}
- Location: ${p.city || 'Not specified'}

Job:
- Title: ${job.title}
- Company: ${job.company}
- Location: ${job.location}
- Remote: ${job.remote ? 'Yes' : 'No'}
- Match Score: ${job.matchScore}%
- Description: ${(job.description || '').slice(0, 500)}

Return JSON only with these keys:
{
  "score": ${job.matchScore},
  "summary": "One sentence summary of the match",
  "strengths": ["strength1", "strength2", "strength3"],
  "gaps": ["gap1", "gap2"],
  "missingSkills": ["skill1", "skill2"],
  "recommendation": "Should apply? Yes/No and why in one sentence",
  "tipsToImprove": ["tip1", "tip2"]
}`;

  try {
    const response = await client.chat.completions.create({
      model:       'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a career coach analyzing job matches. Return valid JSON only.' },
        { role: 'user',   content: prompt },
      ],
      max_tokens:  500,
      temperature: 0.3,
    });

    const raw    = response.choices[0].message.content.replace(/```json|```/g, '').trim();
    const result = JSON.parse(raw);
    await cacheSet(ck, result, 24 * 3600); // 24h — job listings don't change fast
    return result;
  } catch (err) {
    logger.warn(`Job match explanation failed: ${err.message}`);
    return generateFallbackExplanation({ job, user });
  }
};

// ── Resume gap analysis ───────────────────────────────────────────
// Cache: MD5(userId + targetRole) — TTL 6h. Profile changes invalidate naturally.
const analyzeResumeGaps = async ({ user, targetRole }) => {
  const role = targetRole || user.profile?.targetRole || user.profile?.currentRole || 'Software Engineer';
  const ck   = `ai:gaps:${crypto.createHash('md5').update(`${user._id}${role}`).digest('hex')}`;

  const cached = await cacheGet(ck);
  if (cached) { logger.info('[JobAnalyzer] gapAnalysis cache hit'); return cached; }

  if (!process.env.OPENAI_API_KEY) {
    return { targetRole: role, currentSkills: user.profile?.skills || [], missingSkills: [], recommendations: [], overallFit: 50 };
  }

  const client = getClient();
  const p      = user.profile || {};
  const skills = [...(p.skills || []), ...(user.resume?.extractedSkills || [])];

  const prompt = `Analyze skill gaps for this candidate targeting the role: "${role}"

Current profile:
- Current role: ${p.currentRole || 'Not specified'}
- Experience: ${p.experience || 0} years
- Skills: ${skills.join(', ') || 'None listed'}
- Education: ${p.education?.degree || 'Not specified'}

Return JSON only:
{
  "targetRole": "${role}",
  "overallFit": 75,
  "currentSkills": ["skill1", "skill2"],
  "missingSkills": [
    {"skill": "TypeScript", "importance": "high", "reason": "Required in 80% of ${role} jobs"},
    {"skill": "Docker", "importance": "medium", "reason": "Useful for deployment"}
  ],
  "strongPoints": ["point1", "point2"],
  "recommendations": [
    {"action": "Learn TypeScript", "resource": "typescriptlang.org", "timeEstimate": "2-4 weeks"},
    {"action": "Build 2 more projects", "resource": "github.com", "timeEstimate": "1 month"}
  ],
  "salaryRange": "₹8-15 LPA",
  "jobMarketDemand": "high"
}`;

  try {
    const response = await client.chat.completions.create({
      model:       'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a career coach. Return valid JSON only.' },
        { role: 'user',   content: prompt },
      ],
      max_tokens:  800,
      temperature: 0.3,
    });

    const raw    = response.choices[0].message.content.replace(/```json|```/g, '').trim();
    const result = JSON.parse(raw);
    await cacheSet(ck, result, 6 * 3600); // 6h — user profile may change
    return result;
  } catch (err) {
    logger.warn(`Gap analysis failed: ${err.message}`);
    throw err;
  }
};

// ── Company research ──────────────────────────────────────────────
// Cache: MD5(company name) — TTL 7 days. Company info is stable.
const researchCompany = async ({ company, domain }) => {
  const ck     = `ai:company:${crypto.createHash('md5').update(company.toLowerCase()).digest('hex')}`;
  const cached = await cacheGet(ck);
  if (cached) { logger.info(`[JobAnalyzer] companyResearch cache hit: ${company}`); return cached; }

  if (!process.env.OPENAI_API_KEY) return null;

  const client = getClient();

  const prompt = `Give me a brief company overview for "${company}" (domain: ${domain || 'unknown'}).

Return JSON only:
{
  "name": "${company}",
  "description": "What the company does in 2 sentences",
  "industry": "Technology",
  "size": "1000-5000 employees",
  "founded": "2010",
  "headquarters": "Bangalore, India",
  "type": "Private/Public/Startup",
  "glassdoorRating": 4.2,
  "cultureHighlights": ["Good work-life balance", "Learning opportunities"],
  "techStack": ["React", "Node.js", "AWS"],
  "fundingStage": "Series C / Listed / Bootstrapped",
  "pros": ["pro1", "pro2"],
  "cons": ["con1", "con2"],
  "interviewProcess": "Brief description of their interview process",
  "avgSalary": "₹8-20 LPA for tech roles"
}`;

  try {
    const response = await client.chat.completions.create({
      model:       'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a company research assistant. Return valid JSON only. Use your knowledge.' },
        { role: 'user',   content: prompt },
      ],
      max_tokens:  600,
      temperature: 0.2,
    });

    const raw    = response.choices[0].message.content.replace(/```json|```/g, '').trim();
    const result = JSON.parse(raw);
    await cacheSet(ck, result, 7 * 24 * 3600); // 7 days — company info rarely changes
    return result;
  } catch (err) {
    logger.warn(`Company research failed for ${company}: ${err.message}`);
    return null;
  }
};

// ── Fallback explanation ──────────────────────────────────────────
const generateFallbackExplanation = ({ job, user }) => {
  const skills      = user.profile?.skills || [];
  const description = (job.description || '').toLowerCase();
  const matchedSkills = skills.filter(s => description.includes(s.toLowerCase()));
  const missingSkills = skills.filter(s => !description.includes(s.toLowerCase())).slice(0, 3);

  return {
    score:      job.matchScore,
    summary:    `${job.matchScore >= 70 ? 'Strong' : job.matchScore >= 50 ? 'Good' : 'Partial'} match for ${job.title} at ${job.company}`,
    strengths:  matchedSkills.length > 0 ? matchedSkills.map(s => `${s} skill matches`) : ['Role title matches your target'],
    gaps:       missingSkills.map(s => `${s} not mentioned in description`),
    missingSkills,
    recommendation: job.matchScore >= 60 ? 'Yes, apply — good fit' : 'Apply but tailor your resume first',
    tipsToImprove:  ['Add more skills to your profile', 'Upload your resume for better matching'],
  };
};

module.exports = { explainMatch, analyzeResumeGaps, researchCompany };
