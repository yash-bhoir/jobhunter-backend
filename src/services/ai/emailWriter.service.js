const OpenAI  = require('openai');
const crypto  = require('crypto');

const getClient = () => new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Cache helpers ─────────────────────────────────────────────────
let _cache = null;
const getCache  = () => { if (!_cache) { try { _cache = require('../../config/redis').cache; } catch { _cache = null; } } return _cache; };
const cacheGet  = async (k) => { try { return await getCache()?.get(k); } catch { return null; } };
const cacheSet  = async (k, v, ttl) => { try { await getCache()?.set(k, v, ttl); } catch {} };

// ── Generate outreach email ───────────────────────────────────────
// Cache key: MD5(company + jobTitle + candidateName + skills[:3] + jd[:200])
// TTL: 3 days — same job+candidate combo → identical email. Saves ~500 tokens per hit.
const generateOutreachEmail = async ({ recruiterName, company, jobTitle, jobUrl, jobDescription, candidate }) => {
  const jdSnippet  = (jobDescription || '').slice(0, 200);
  const cacheInput = `${company}||${jobTitle}||${candidate.name}||${(candidate.skills || []).slice(0, 3).join(',')}||${jdSnippet}`;
  const ck         = `ai:email2:${crypto.createHash('md5').update(cacheInput).digest('hex')}`;
  const cached     = await cacheGet(ck);
  if (cached) return { ...cached, tokensUsed: 0, fromCache: true };

  // Build signature block
  const contactParts = [];
  if (candidate.phone)       contactParts.push(candidate.phone);
  if (candidate.linkedinUrl) contactParts.push(candidate.linkedinUrl);
  const contactLine = contactParts.join(' | ');
  const signature   = `Best regards,\n${candidate.name}${contactLine ? `\n${contactLine}` : ''}`;

  if (!process.env.OPENAI_API_KEY) {
    const skills4 = (candidate.skills || []).slice(0, 4).join(', ');
    return {
      subject: `${jobTitle} — ${candidate.name}`,
      body: `Dear ${recruiterName || 'Hiring Manager'},\n\nI came across the ${jobTitle} role at ${company} and believe my ${candidate.experience}+ years as a ${candidate.currentRole}, with expertise in ${skills4}, align closely with what you're looking for.\n\nI'd welcome a quick 15-minute call to explore how I can contribute to ${company}'s goals.\n\n${signature}`,
      tokensUsed: 0,
    };
  }

  const client = getClient();

  // Trim JD to first 900 chars to stay within token budget while giving real context
  const jdContext = jobDescription
    ? `\nJob Description (excerpt):\n"""\n${jobDescription.slice(0, 900).trim()}\n"""`
    : '';

  const prompt = `You are a senior career coach and expert email copywriter. Write a compelling cold outreach email from a job seeker to a recruiter that stands out and gets a reply.

CANDIDATE PROFILE:
- Name: ${candidate.name}
- Current Role: ${candidate.currentRole}
- Total Experience: ${candidate.experience} year${candidate.experience !== 1 ? 's' : ''}
- Key Skills: ${(candidate.skills || []).slice(0, 8).join(', ')}
- Expected CTC: ${candidate.expectedCTC || 'open to discussion'}
${candidate.phone ? `- Phone: ${candidate.phone}` : ''}
${candidate.linkedinUrl ? `- LinkedIn: ${candidate.linkedinUrl}` : ''}

TARGET OPPORTUNITY:
- Role: ${jobTitle}
- Company: ${company}
- Recruiter/Hiring Manager: ${recruiterName || 'Hiring Manager'}
${jobUrl ? `- Job Link: ${jobUrl}` : ''}${jdContext}

EXACT SIGNATURE (place at the very end, no changes):
${signature}

WRITING INSTRUCTIONS:
1. Subject line: specific and compelling — mention role + a brief value hook (e.g. "5-yr React dev — ${jobTitle} at ${company}")
2. Opening: strong hook — NOT "I am writing to express my interest". Instead, lead with a specific value statement or relevant achievement.
3. Body (2 short paragraphs):
   - Para 1: Connect 2-3 of the candidate's strongest skills directly to the role's requirements (use the JD if provided)
   - Para 2: Express genuine interest in the specific company/team and propose a low-friction next step (15-min call)
4. Length: 150–200 words total (professional but not verbose)
5. Tone: confident, warm, direct — NOT grovelling or generic
6. End with the exact signature above — no extra placeholders or closing lines

Return ONLY valid JSON (no markdown, no code fences):
{"subject": "...", "body": "..."}`;

  const response = await client.chat.completions.create({
    model:       'gpt-4o-mini',
    messages: [
      {
        role:    'system',
        content: 'You are an expert career coach who writes highly effective job outreach emails. Return only valid JSON with keys "subject" and "body". No markdown. No code fences.',
      },
      { role: 'user', content: prompt },
    ],
    max_tokens:  600,
    temperature: 0.65,
  });

  const raw = response.choices[0].message.content
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Fallback: extract subject/body with regex if JSON is malformed
    const subjectMatch = raw.match(/"subject"\s*:\s*"([^"]+)"/);
    const bodyMatch    = raw.match(/"body"\s*:\s*"([\s\S]+?)"\s*\}/);
    parsed = {
      subject: subjectMatch?.[1] || `${jobTitle} — ${candidate.name}`,
      body:    bodyMatch?.[1]?.replace(/\\n/g, '\n') || raw,
    };
  }

  const result = {
    subject:    parsed.subject || `${jobTitle} — ${candidate.name}`,
    body:       parsed.body    || parsed.email || '',
    tokensUsed: response.usage?.total_tokens || 0,
  };

  await cacheSet(ck, result, 3 * 24 * 3600);
  return result;
};

// ── Enhance / rewrite existing email ─────────────────────────────
const enhanceOutreachEmail = async ({ subject, body, jobTitle, company, jobDescription, candidate }) => {
  if (!process.env.OPENAI_API_KEY) {
    return { subject, body, tokensUsed: 0 };
  }

  const client = getClient();

  const jdContext = jobDescription
    ? `\nJob Description (excerpt):\n"""\n${jobDescription.slice(0, 600).trim()}\n"""`
    : '';

  const contactParts = [];
  if (candidate?.phone)       contactParts.push(candidate.phone);
  if (candidate?.linkedinUrl) contactParts.push(candidate.linkedinUrl);
  const signature = candidate
    ? `Best regards,\n${candidate.name}${contactParts.length ? `\n${contactParts.join(' | ')}` : ''}`
    : null;

  const prompt = `You are a senior career coach and email copywriter. Enhance and rewrite the email below to make it more professional, compelling, and personalized.

CONTEXT:
- Role: ${jobTitle || 'the position'} at ${company || 'the company'}
${candidate ? `- Candidate: ${candidate.name}, ${candidate.experience}yr ${candidate.currentRole}, skills: ${(candidate.skills || []).slice(0, 6).join(', ')}` : ''}${jdContext}

ORIGINAL EMAIL:
Subject: ${subject}
Body:
${body}

ENHANCEMENT INSTRUCTIONS:
1. Keep the sender's core message and intent
2. Open with a stronger, specific hook — not "I am writing to express my interest"
3. Make skill mentions more concrete and tied to the role
4. Sharpen the CTA to something low-friction (15-min call)
5. Remove filler words and passive language
6. Target 150–200 words — concise and punchy
7. Keep the exact same signature if present
${signature ? `8. Ensure this exact signature is at the end:\n${signature}` : ''}

Return ONLY valid JSON (no markdown):
{"subject": "...", "body": "..."}`;

  const response = await client.chat.completions.create({
    model:       'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You enhance professional outreach emails. Return only valid JSON with keys "subject" and "body". No markdown.' },
      { role: 'user',   content: prompt },
    ],
    max_tokens:  600,
    temperature: 0.6,
  });

  const raw = response.choices[0].message.content
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch {
    const sm = raw.match(/"subject"\s*:\s*"([^"]+)"/);
    const bm = raw.match(/"body"\s*:\s*"([\s\S]+?)"\s*\}/);
    parsed = { subject: sm?.[1] || subject, body: bm?.[1]?.replace(/\\n/g, '\n') || body };
  }

  return {
    subject:    parsed.subject || subject,
    body:       parsed.body    || body,
    tokensUsed: response.usage?.total_tokens || 0,
  };
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

module.exports = { generateOutreachEmail, enhanceOutreachEmail, generateInterviewQuestions };