const OpenAI  = require('openai');
const crypto  = require('crypto');

const getClient = () => new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Cache helpers ─────────────────────────────────────────────────
let _cache = null;
const getCache  = () => { if (!_cache) { try { _cache = require('../../config/redis').cache; } catch { _cache = null; } } return _cache; };
const cacheGet  = async (k) => { try { return await getCache()?.get(k); } catch { return null; } };
const cacheSet  = async (k, v, ttl) => { try { await getCache()?.set(k, v, ttl); } catch {} };

// Tone / structure hints so parallel generations for the same job are not clones
const TONE_HINTS = [
  'Lead with one concrete metric or outcome tied to the role, then connect skills.',
  'Open by referencing the company mission or product area (one short phrase), then your fit.',
  'Start with a crisp problem–solution framing: a challenge teams in this role face, then how you address it.',
];

// ── Generate outreach email ───────────────────────────────────────
// Cache key INCLUDES recipient email + variation so each HR contact gets distinct copy.
// skipCache: true for "Regenerate" / when uniqueness is required regardless of cache.
const generateOutreachEmail = async ({
  recruiterName,
  company,
  jobTitle,
  jobUrl,
  jobDescription,
  candidate,
  recipientEmail,
  recipientName,
  skipCache = false,
  variationIndex = 0,
}) => {
  const jdSnippet = (jobDescription || '').slice(0, 200);
  const recNorm   = (recipientEmail || '').toLowerCase().trim() || 'generic';
  const recName   = (recipientName || recruiterName || '').trim() || '';
  const cacheInput = `${company}||${jobTitle}||${candidate.name}||${(candidate.skills || []).slice(0, 3).join(',')}||${jdSnippet}||${recNorm}||v${variationIndex % 3}`;
  const ck         = `ai:email3:${crypto.createHash('md5').update(cacheInput).digest('hex')}`;
  if (!skipCache) {
    const cached = await cacheGet(ck);
    if (cached) return { ...cached, tokensUsed: 0, fromCache: true };
  }

  // Build signature block
  const contactParts = [];
  if (candidate.phone)       contactParts.push(candidate.phone);
  if (candidate.linkedinUrl) contactParts.push(candidate.linkedinUrl);
  const contactLine = contactParts.join(' | ');
  const signature   = `Best regards,\n${candidate.name}${contactLine ? `\n${contactLine}` : ''}`;

  if (!process.env.OPENAI_API_KEY) {
    const skills4 = (candidate.skills || []).slice(0, 4).join(', ');
    const greet = recName || recruiterName || 'Hiring Manager';
    const uniq = recipientEmail ? ` (re: ${recipientEmail.split('@')[0]})` : '';
    return {
      subject: `${jobTitle} — ${candidate.name}${uniq}`,
      body: `Dear ${greet},\n\nI came across the ${jobTitle} role at ${company} and believe my ${candidate.experience}+ years as a ${candidate.currentRole}, with expertise in ${skills4}, align closely with what you're looking for.\n\nI'd welcome a quick 15-minute call to explore how I can contribute to ${company}'s goals.\n\n${signature}`,
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
- Recruiter/Hiring Manager (if known): ${recruiterName || 'Hiring Manager'}
${recipientEmail ? `- Recipient email (must be treated as a UNIQUE addressee; personalize subtly — do NOT mass-mail wording): ${recipientEmail}` : ''}
${recName ? `- Recipient display name (use in greeting if natural): ${recName}` : ''}
${jobUrl ? `- Job Link: ${jobUrl}` : ''}${jdContext}

EXACT SIGNATURE (place at the very end, no changes):
${signature}

STRUCTURE / TONE SEED (follow closely — varies per recipient so emails are not duplicates):
${TONE_HINTS[variationIndex % TONE_HINTS.length]}

WRITING INSTRUCTIONS:
1. Greeting: use "${recName || recruiterName || 'Hiring Manager'}" when appropriate; if only email is known, use "Hello," or "Hi there," — never a wrong name.
2. Subject line: MUST differ from any generic "${jobTitle} application" — include a distinct hook (skill + outcome) tailored to this thread.
3. Opening: strong hook — NOT "I am writing to express my interest". Vary sentence order vs. a template.
4. Body (2 short paragraphs):
   - Para 1: Connect 2-3 skills to the JD; mention the role title once in a fresh way
   - Para 2: Company-specific interest + low-friction CTA (15-min call)
5. Length: 150–200 words — professional, not spammy; avoid repeating the same adjectives you'd use for another recipient at the same company.
6. If recipient email suggests a real name (e.g. jane.doe@), you may lightly personalize — do not fabricate biographical facts.
7. End with the exact signature above — no extra placeholders

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
    temperature: recipientEmail ? 0.82 : 0.65,
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

  if (!skipCache) await cacheSet(ck, result, 3 * 24 * 3600);
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