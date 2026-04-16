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

// ── Glassdoor data via SerpAPI ────────────────────────────────────
// Returns real rating + review count from Glassdoor if SERPAPI_KEY is set.
// Uses a single search call — employer search includes overall_rating directly.
const fetchGlassdoorData = async (company) => {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return null;

  try {
    const axios = require('axios');
    const { data } = await axios.get('https://serpapi.com/search', {
      params: {
        engine:   'glassdoor',
        q:        company,
        type:     'employer',
        api_key:  apiKey,
      },
      timeout: 8000,
    });

    // SerpAPI Glassdoor employer search returns an employers array.
    // Each entry has: id, name, overall_rating, reviews_count, recommend_to_friend, ceo_approval_rate
    const employer = data?.employers?.[0];
    if (!employer) return null;

    const employerId = employer.id;

    return {
      glassdoorRating:      employer.overall_rating        || null,
      glassdoorReviewCount: employer.reviews_count         || null,
      glassdoorCeoApproval: employer.ceo_approval_rate     || null,
      glassdoorRecommend:   employer.recommend_to_friend   || null,
      // Direct link to the company's Glassdoor overview page
      glassdoorUrl: employerId
        ? `https://www.glassdoor.com/Overview/Working-at-${encodeURIComponent(employer.name || company)}-EI_IE${employerId}.htm`
        : null,
      realData: true,
    };
  } catch (err) {
    logger.warn(`[JobAnalyzer] Glassdoor fetch failed for ${company}: ${err.message}`);
    return null;
  }
};

// ── Company research ──────────────────────────────────────────────
// Real Glassdoor data (SerpAPI) + AI for description/techStack/pros/cons.
// Cache: MD5(company name) — TTL 7 days. Company info is stable.
const researchCompany = async ({ company, domain }) => {
  const ck     = `ai:company:${crypto.createHash('md5').update(company.toLowerCase()).digest('hex')}`;
  const cached = await cacheGet(ck);
  if (cached) { logger.info(`[JobAnalyzer] companyResearch cache hit: ${company}`); return cached; }

  // Always build Glassdoor search URL (works without API key)
  const glassdoorSearchUrl = `https://www.glassdoor.com/Search/results.htm?keyword=${encodeURIComponent(company)}`;
  const linkedinUrl        = `https://www.linkedin.com/company/${encodeURIComponent(company.toLowerCase().replace(/\s+/g, '-'))}/`;
  const crunchbaseUrl      = `https://www.crunchbase.com/search/organizations/field/organizations/short_description/${encodeURIComponent(company)}`;

  // Fetch real Glassdoor data in parallel with AI
  const [glassdoorData, aiResult] = await Promise.all([
    fetchGlassdoorData(company),
    (async () => {
      if (!process.env.OPENAI_API_KEY) return null;
      const client = getClient();
      const prompt = `Give me a factual company overview for "${company}" (domain: ${domain || 'unknown'}).
Only include information you are confident is accurate. Do NOT invent ratings, salaries, or funding stages.

Return JSON only — set any field to null if you are not confident:
{
  "description": "What the company does in 2-3 sentences (factual)",
  "industry": "e.g. Technology / Finance / Healthcare",
  "size": "e.g. 1,000–5,000 employees OR null",
  "founded": "year as string OR null",
  "headquarters": "City, Country OR null",
  "type": "Public / Private / Startup OR null",
  "techStack": ["only include if clearly known from public info, else []"],
  "pros": ["2-3 commonly cited pros from employee reviews if known, else []"],
  "cons": ["2-3 commonly cited cons from employee reviews if known, else []"],
  "interviewProcess": "Brief description if commonly known, else null"
}`;

      try {
        const response = await client.chat.completions.create({
          model:       'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'You are a factual company research assistant. Return valid JSON only. Never invent numbers — set unknown fields to null.' },
            { role: 'user',   content: prompt },
          ],
          max_tokens:  500,
          temperature: 0.1,
        });
        const raw = response.choices[0].message.content.replace(/```json|```/g, '').trim();
        return JSON.parse(raw);
      } catch (err) {
        logger.warn(`AI company research failed for ${company}: ${err.message}`);
        return null;
      }
    })(),
  ]);

  const result = {
    name:   company,
    // AI-sourced fields (labeled so frontend can show disclaimer)
    ...(aiResult || {}),
    aiGenerated: true,
    // Real links — always present
    glassdoorSearchUrl,
    linkedinUrl,
    crunchbaseUrl,
    // Real Glassdoor data — overrides AI if available
    ...(glassdoorData || {}),
  };

  await cacheSet(ck, result, 7 * 24 * 3600); // 7-day cache
  return result;
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

// ── Deep Job Evaluation (career-ops A-F framework) ───────────────
// Inspired by career-ops oferta.md — 6-block evaluation
// Block A: Role context + archetype
// Block B: CV gap analysis
// Block C: Seniority positioning
// Block D: Salary / compensation data
// Block E: Top CV changes for this role
// Block F: Interview prep questions
const deepEvaluateJob = async ({ job, user }) => {
  if (!process.env.OPENAI_API_KEY) {
    return {
      score:        job.matchScore / 20, // convert 0-100 → 0-5
      archetype:    'Unknown',
      summary:      `${job.title} at ${job.company}`,
      cvGaps:       [],
      topCvChanges: ['Tailor your headline for this role'],
      salaryRange:  null,
      interviewQs:  ['Tell me about yourself', 'Why this company?'],
    };
  }

  const client = getClient();
  const p      = user?.profile || {};
  const skills = [...(p.skills || []), ...(user?.resume?.extractedSkills || [])];
  const desc   = (job.description || '').slice(0, 1200);

  const prompt = `You are a senior career coach. Evaluate this job for this candidate using the 6-block framework.

CANDIDATE:
- Name: ${p.firstName} ${p.lastName}
- Current Role: ${p.currentRole || 'Not specified'}
- Experience: ${p.experience || 0} years
- Target Role: ${p.targetRole || 'Not specified'}
- Skills: ${skills.join(', ') || 'None listed'}
- Work Preference: ${p.workType || 'any'}
- Current CTC: ${p.currentCTC || 'Not specified'}
- Expected CTC: ${p.expectedCTC || 'Not specified'}

JOB:
- Title: ${job.title}
- Company: ${job.company}
- Location: ${job.location || 'Not specified'}
- Remote: ${job.remote ? 'Yes' : 'No'}
- Salary: ${job.salary || 'Not specified'}
- Description: ${desc}

Return JSON only — be specific, not generic:
{
  "score": 3.8,
  "archetype": "one of: Fullstack | Backend | Frontend | Mobile | DevOps | ML/AI | PM | Design | Data | Management | Sales | Other",
  "summary": "One sentence TL;DR of this role and fit",
  "roleContext": "What this role actually does day-to-day in 2 sentences",
  "cvGaps": ["Specific gap 1 — what's missing and why it matters", "Gap 2"],
  "gapMitigations": ["How to address gap 1", "How to address gap 2"],
  "topCvChanges": ["Specific CV tweak 1", "Specific CV tweak 2", "Specific CV tweak 3"],
  "salaryRange": "Market range for this role based on industry knowledge e.g. ₹18-28 LPA or $120-160k",
  "salaryVerdict": "Under-market / Fair / Premium",
  "seniorityFit": "Your ${p.experience || 0} years fits the [Senior/Mid/Junior] level this role targets",
  "interviewQs": [
    "Technical question likely to be asked",
    "Behavioral question about past experience",
    "Culture fit question specific to ${job.company}",
    "A tricky scenario question"
  ],
  "redFlags": ["Any concern about this role or company — or empty array"],
  "verdict": "STRONG APPLY | APPLY WITH TAILORING | SKIP | RESEARCH MORE"
}`;

  try {
    const response = await client.chat.completions.create({
      model:       'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a career coach running a structured job evaluation. Return valid JSON only. Be specific and actionable — avoid generic advice.' },
        { role: 'user',   content: prompt },
      ],
      max_tokens:  1000,
      temperature: 0.3,
    });

    const raw    = response.choices[0].message.content.replace(/```json|```/g, '').trim();
    const result = JSON.parse(raw);
    return result;
  } catch (err) {
    logger.warn(`[JobAnalyzer] deepEvaluate failed: ${err.message}`);
    throw err;
  }
};

// ── Interview Prep Generator ──────────────────────────────────────
// Generates STAR+R questions mapped to JD requirements (career-ops Block F)
const generateInterviewPrep = async ({ job, user }) => {
  if (!process.env.OPENAI_API_KEY) {
    return {
      questions: [
        { question: 'Tell me about yourself', starHint: 'Situation → your background, Task → what you wanted to achieve, Action → steps taken, Result → current position, Reflection → what you learned' },
        { question: `Why do you want to work at ${job.company}?`, starHint: 'Research the company mission and connect it to your own goals and values.' },
      ],
    };
  }

  const client = getClient();
  const p      = user?.profile || {};
  const skills = [...(p.skills || []), ...(user?.resume?.extractedSkills || [])];
  const desc   = (job.description || '').slice(0, 1000);

  const prompt = `Generate interview prep for this candidate for this specific role.

CANDIDATE: ${p.experience || 0} years exp, skills: ${skills.slice(0, 10).join(', ')}
JOB: ${job.title} at ${job.company}
DESCRIPTION: ${desc}

Return JSON only:
{
  "questions": [
    {
      "question": "Specific behavioral question mapped to a JD requirement",
      "type": "behavioral | technical | culture | situational",
      "starHint": "Brief STAR+R coaching hint — what Situation to describe, what Result to highlight, what Reflection shows seniority"
    }
  ],
  "companyResearchTips": ["Research tip 1 specific to ${job.company}", "Tip 2"],
  "keywordsToMention": ["keyword1 from JD to weave into answers"],
  "questionsToAsk": ["Smart question to ask the interviewer about this role"]
}

Generate exactly 6 questions: 2 technical, 2 behavioral, 1 situational, 1 culture-fit.`;

  try {
    const response = await client.chat.completions.create({
      model:       'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are an interview coach. Generate specific, role-relevant interview prep. Return valid JSON only.' },
        { role: 'user',   content: prompt },
      ],
      max_tokens:  800,
      temperature: 0.4,
    });

    const raw    = response.choices[0].message.content.replace(/```json|```/g, '').trim();
    return JSON.parse(raw);
  } catch (err) {
    logger.warn(`[JobAnalyzer] interviewPrep failed: ${err.message}`);
    throw err;
  }
};

module.exports = { explainMatch, analyzeResumeGaps, researchCompany, deepEvaluateJob, generateInterviewPrep };
