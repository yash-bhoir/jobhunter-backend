/**
 * Maps User document → structured resume sections for LaTeX / PDF generation.
 * Keeps output compact for one-page layouts.
 */

const LATEX_SPECIAL = /([\\%$#&_{}~^])/g;
const latexEscape = (s) => {
  if (!s) return '';
  return String(s)
    .replace(/\\/g, '\\textbackslash{}')
    .replace(LATEX_SPECIAL, (_, ch) => {
      const map = { '%': '\\%', $: '\\$', '#': '\\#', '&': '\\&', _: '\\_', '{': '\\{', '}': '\\}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}' };
      return map[ch] || `\\${ch}`;
    })
    .replace(/\n/g, ' ')
    .trim();
};

const truncateWords = (text, maxLen) => {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen - 1).trim()}…`;
};

/**
 * @param {import('mongoose').Document} user Mongoose user with profile (+ optional resume summary)
 */
function mapUserToResumeSections(user) {
  const p = user?.profile || {};
  const name = user?.fullName || `${p.firstName || ''} ${p.lastName || ''}`.trim() || 'Your Name';
  const phone = p.phone || '';
  const email = user?.email || '';
  const city = p.city || '';
  const linkedin = p.linkedinUrl || '';
  const portfolio = p.portfolioUrl || '';

  const headerLine = [phone, email, city].filter(Boolean).join(' | ');
  const links = [linkedin, portfolio].filter(Boolean);

  const skills = (p.skills || []).slice(0, 16);
  const secondary = (p.secondarySkills || []).slice(0, 8);
  const allSkills = [...new Set([...skills, ...secondary])];

  const edu = [];
  if (p.education?.degree || p.education?.college) {
    edu.push({
      school: p.education.college || 'University',
      location: city || '',
      degree: p.education.degree || 'Degree',
      dates: p.education.year ? `${p.education.year}` : '',
    });
  }

  const experience = [];
  if (p.currentRole || p.experience != null) {
    const bullets = [];
    if (p.targetRole) bullets.push(`Targeting: ${truncateWords(p.targetRole, 120)}`);
    if (p.experience != null) bullets.push(`${p.experience}+ years professional experience`);
    if (allSkills.length) bullets.push(`Core strengths: ${allSkills.slice(0, 8).join(', ')}`);
    experience.push({
      title: p.currentRole || 'Professional',
      company: '—',
      location: city || '',
      dates: 'Present',
      bullets: bullets.slice(0, 4).map((b) => truncateWords(b, 160)),
    });
  }

  const summary = user?.resume?.summary || '';
  const parsedSkills = user?.resume?.extractedSkills || [];

  const projects = [];
  if (summary) {
    projects.push({
      name: 'Profile summary',
      tech: '',
      year: '',
      bullets: [truncateWords(summary, 220)],
    });
  }
  if (parsedSkills.length && !summary) {
    projects.push({
      name: 'Skills (from resume parse)',
      tech: parsedSkills.slice(0, 6).join(', '),
      year: '',
      bullets: [],
    });
  }

  return {
    name,
    phone,
    email,
    city,
    linkedin,
    portfolio,
    headerLine,
    links,
    education: edu.slice(0, 2),
    experience: experience.slice(0, 2),
    projects: projects.slice(0, 2),
    skillGroups: [
      { label: 'Languages & skills', value: allSkills.slice(0, 14).join(', ') || 'Add skills in Profile' },
      { label: 'Target role', value: p.targetRole || p.currentRole || '—' },
    ],
  };
}

/**
 * Builds fallback plain-text "resume" from profile when PDF text extraction fails.
 */
function buildProfileFallbackResumeText(user) {
  const p = user?.profile || {};
  const lines = [];
  const name = user?.fullName || `${p.firstName || ''} ${p.lastName || ''}`.trim();
  if (name) lines.push(name);
  if (p.phone) lines.push(`Phone: ${p.phone}`);
  if (user?.email) lines.push(`Email: ${user.email}`);
  if (p.city) lines.push(`Location: ${p.city}`);
  if (p.linkedinUrl) lines.push(`LinkedIn: ${p.linkedinUrl}`);
  if (p.currentRole) lines.push(`Current role: ${p.currentRole}`);
  if (p.experience != null) lines.push(`Experience: ${p.experience} years`);
  if (p.targetRole) lines.push(`Target role: ${p.targetRole}`);
  if ((p.skills || []).length) lines.push(`Skills: ${p.skills.join(', ')}`);
  if (p.education?.degree) lines.push(`Education: ${p.education.degree} — ${p.education.college || ''} ${p.education.year || ''}`);
  if (user?.resume?.summary) lines.push(`Summary: ${user.resume.summary}`);
  if ((user?.resume?.extractedSkills || []).length) {
    lines.push(`Parsed resume skills: ${user.resume.extractedSkills.join(', ')}`);
  }
  return lines.join('\n');
}

module.exports = { mapUserToResumeSections, latexEscape, buildProfileFallbackResumeText };
