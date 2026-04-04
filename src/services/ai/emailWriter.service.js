const OpenAI  = require('openai');
const crypto  = require('crypto');

const getClient = () => new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Cache helpers ─────────────────────────────────────────────────
let _cache = null;
const getCache  = () => { if (!_cache) { try { _cache = require('../../config/redis').cache; } catch { _cache = null; } } return _cache; };
const cacheGet  = async (k) => { try { return await getCache()?.get(k); } catch { return null; } };
const cacheSet  = async (k, v, ttl) => { try { await getCache()?.set(k, v, ttl); } catch {} };

// ── Generate outreach email ───────────────────────────────────────
// Cache key: MD5(company + jobTitle + candidateName + skills[:3])
// TTL: 3 days — same job+candidate combo → identical email. Saves ~400 tokens per hit.
const generateOutreachEmail = async ({ recruiterName, company, jobTitle, jobUrl, candidate }) => {
  const cacheInput = `${company}||${jobTitle}||${candidate.name}||${(candidate.skills || []).slice(0, 3).join(',')}`;
  const ck         = `ai:email:${crypto.createHash('md5').update(cacheInput).digest('hex')}`;
  const cached     = await cacheGet(ck);
  if (cached) return { ...cached, tokensUsed: 0, fromCache: true };
  // Build contact line for signature
  const contactParts = [];
  if (candidate.phone)       contactParts.push(candidate.phone);
  if (candidate.linkedinUrl) contactParts.push(candidate.linkedinUrl);
  const contactLine = contactParts.length > 0 ? contactParts.join(' | ') : '';

  const signature = `Best regards,\n${candidate.name}${contactLine ? `\n${contactLine}` : ''}`;

  if (!process.env.OPENAI_API_KEY) {
    return {
      subject: `Application for ${jobTitle} at ${company}`,
      body: `Dear ${recruiterName || 'Hiring Manager'},\n\nI am writing to express my interest in the ${jobTitle} position at ${company}.\n\nI have ${candidate.experience} years of experience as a ${candidate.currentRole} with expertise in ${(candidate.skills || []).slice(0, 4).join(', ')}.\n\nI would love to discuss how I can contribute to your team.\n\n${signature}`,
      tokensUsed: 0,
    };
  }

  const client = getClient();

  const prompt = `Write a professional cold outreach email from a job seeker to a recruiter.

Candidate details:
- Name: ${candidate.name}
- Current role: ${candidate.currentRole}
- Experience: ${candidate.experience} years
- Key skills: ${(candidate.skills || []).slice(0, 6).join(', ')}
- Expected CTC: ${candidate.expectedCTC || 'negotiable'}

Job details:
- Position: ${jobTitle}
- Company: ${company}
- Recruiter: ${recruiterName || 'Hiring Manager'}
- Job URL: ${jobUrl || 'not provided'}

Signature to use exactly at the end (do NOT add any other closing or placeholder):
${signature}

Requirements:
- Under 150 words
- Professional but warm tone
- Mention 2-3 specific skills relevant to the role
- End with a clear call to action, then the exact signature above
- Return JSON with keys: subject (email subject line) and body (email body only, no subject)`;

  const response = await client.chat.completions.create({
    model:       'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You write concise professional job application emails. Always return valid JSON only, no markdown.' },
      { role: 'user',   content: prompt },
    ],
    max_tokens:  400,
    temperature: 0.7,
  });

  const raw = response.choices[0].message.content
    .replace(/```json|```/g, '')
    .trim();

  const parsed = JSON.parse(raw);

  const result = {
    subject:    parsed.subject || `Application for ${jobTitle} at ${company}`,
    body:       parsed.body    || parsed.email || '',
    tokensUsed: response.usage?.total_tokens || 0,
  };

  // Cache 3 days — same job+candidate always produces same email, saves ~400 tokens per hit
  await cacheSet(ck, result, 3 * 24 * 3600);

  return result;
};

// ── Generate interview prep questions ────────────────────────────
const generateInterviewQuestions = async ({ jobTitle, company, jobDescription, candidateSkills }) => {
  if (!process.env.OPENAI_API_KEY) return { questions: [], tokensUsed: 0 };

  const client = getClient();

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'Generate interview questions. Return JSON only with key "questions" as array of {question, type, answer} objects.' },
      { role: 'user',   content: `Job: ${jobTitle} at ${company}\nDescription: ${(jobDescription || '').slice(0, 500)}\nCandidate skills: ${(candidateSkills || []).join(', ')}\n\nGenerate 8 likely interview questions with model answers.` },
    ],
    max_tokens:  1000,
    temperature: 0.6,
  });

  const raw  = response.choices[0].message.content.replace(/```json|```/g, '').trim();
  const data = JSON.parse(raw);

  return {
    questions:  data.questions || [],
    tokensUsed: response.usage?.total_tokens || 0,
  };
};

module.exports = { generateOutreachEmail, generateInterviewQuestions };