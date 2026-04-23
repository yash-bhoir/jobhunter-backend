const { mapUserToResumeSections, latexEscape } = require('./resumeContent.mapper');

// Jake Gutierrez / sb2nov — matches common Overleaf resume (11pt, margins, macros).
const PREAMBLE = String.raw`%-------------------------
% Resume in Latex
% Author : Jake Gutierrez
% Based off of: https://github.com/sb2nov/resume
% License : MIT
%------------------------

\documentclass[letterpaper,11pt]{article}

\usepackage{latexsym}
\usepackage[empty]{fullpage}
\usepackage{titlesec}
\usepackage{marvosym}
\usepackage[usenames,dvipsnames]{color}
\usepackage{verbatim}
\usepackage{enumitem}
\usepackage[hidelinks]{hyperref}
\usepackage{fancyhdr}
\usepackage[english]{babel}
\usepackage{tabularx}
\input{glyphtounicode}


%----------FONT OPTIONS----------
% sans-serif
% \usepackage[sfdefault]{FiraSans}
% \usepackage[sfdefault]{roboto}
% \usepackage[sfdefault]{noto-sans}
% \usepackage[default]{sourcesanspro}

% serif
% \usepackage{CormorantGaramond}
% \usepackage{charter}


\pagestyle{fancy}
\fancyhf{} % clear all header and footer fields
\fancyfoot{}
\renewcommand{\headrulewidth}{0pt}
\renewcommand{\footrulewidth}{0pt}

% Adjust margins
\addtolength{\oddsidemargin}{-0.5in}
\addtolength{\evensidemargin}{-0.5in}
\addtolength{\textwidth}{1in}
\addtolength{\topmargin}{-.5in}
\addtolength{\textheight}{1.0in}

\urlstyle{same}

\raggedbottom
\raggedright
\setlength{\tabcolsep}{0in}

% Sections formatting
\titleformat{\section}{
  \vspace{-4pt}\scshape\raggedright\large
}{}{0em}{}[\color{black}\titlerule \vspace{-5pt}]

% Ensure that generate pdf is machine readable/ATS parsable
\pdfgentounicode=1

%-------------------------
% Custom commands
\newcommand{\resumeItem}[1]{
  \item\small{
    {#1 \vspace{-2pt}}
  }
}

\newcommand{\resumeSubheading}[4]{
  \vspace{-2pt}\item
    \begin{tabular*}{0.97\textwidth}[t]{l@{\extracolsep{\fill}}r}
      \textbf{#1} & #2 \\
      \textit{\small#3} & \textit{\small #4} \\
    \end{tabular*}\vspace{-7pt}
}

\newcommand{\resumeSubSubheading}[2]{
    \item
    \begin{tabular*}{0.97\textwidth}{l@{\extracolsep{\fill}}r}
      \textit{\small#1} & \textit{\small #2} \\
    \end{tabular*}\vspace{-7pt}
}

\newcommand{\resumeProjectHeading}[2]{
    \item
    \begin{tabular*}{0.97\textwidth}{l@{\extracolsep{\fill}}r}
      \small#1 & #2 \\
    \end{tabular*}\vspace{-7pt}
}

\newcommand{\resumeSubItem}[1]{\resumeItem{#1}\vspace{-4pt}}

\renewcommand\labelitemii{$\vcenter{\hbox{\tiny$\bullet$}}$}

\newcommand{\resumeSubHeadingListStart}{\begin{itemize}[leftmargin=0.15in, label={}]}
\newcommand{\resumeSubHeadingListEnd}{\end{itemize}}
\newcommand{\resumeItemListStart}{\begin{itemize}}
\newcommand{\resumeItemListEnd}{\end{itemize}\vspace{-5pt}}

%-------------------------------------------
%%%%%%  RESUME STARTS HERE  %%%%%%%%%%%%%%%%%%%%%%%%%%%%


\begin{document}

%----------HEADING----------
% \begin{tabular*}{\textwidth}{l@{\extracolsep{\fill}}r}
%   \textbf{\href{http://sourabhbajaj.com/}{\Large Sourabh Bajaj}} & Email : \href{mailto:sourabh@sourabhbajaj.com}{sourabh@sourabhbajaj.com}\\
%   \href{http://sourabhbajaj.com/}{http://www.sourabhbajaj.com} & Mobile : +1-123-456-7890 \\
% \end{tabular*}

\begin{center}
    \textbf{\Huge \scshape {{NAME}}} \\ \vspace{1pt}
    \small {{HEADER}}
\end{center}


`;

/** usepackage + layout + \\resume* macros (same as built-in preamble, without \\documentclass / \\begin{document}). */
const _pDoc = PREAMBLE.indexOf('\\begin{document}');
const _pPkg = PREAMBLE.indexOf('\\usepackage{latexsym}');
const LATEX_RESUME_MACROS_BLOCK =
  _pDoc === -1 || _pPkg === -1 ? '' : `${PREAMBLE.slice(_pPkg, _pDoc).trim()}\n`;

function buildLatexDocumentFromSections(sections) {
  const esc = latexEscape;
  const name = esc(sections.name);
  const headerBits = [];
  if (sections.phone) headerBits.push(esc(sections.phone));
  if (sections.email) headerBits.push(`\\href{mailto:${esc(sections.email)}}{\\underline{${esc(sections.email)}}}`);
  if (sections.city) headerBits.push(esc(sections.city));
  if (sections.linkedin) headerBits.push(`\\href{${esc(sections.linkedin)}}{\\underline{${esc(sections.linkedin)}}}`);
  if (sections.portfolio) headerBits.push(`\\href{${esc(sections.portfolio)}}{\\underline{${esc(sections.portfolio)}}}`);
  const header = headerBits.join(' $|$ ');

  let body = '';

  if (sections.education?.length) {
    body += '\n%-----------EDUCATION-----------\n\\section{Education}\n  \\resumeSubHeadingListStart\n';
    for (const e of sections.education) {
      body += `    \\resumeSubheading\n      {${esc(e.school)}}{${esc(e.location)}}\n      {${esc(e.degree)}}{${esc(e.dates)}}\n`;
    }
    body += '  \\resumeSubHeadingListEnd\n\n';
  }

  if (sections.experience?.length) {
    body += '\n%-----------EXPERIENCE-----------\n\\section{Experience}\n  \\resumeSubHeadingListStart\n';
    for (const x of sections.experience) {
      body += `    \\resumeSubheading\n      {${esc(x.title)}}{${esc(x.dates)}}\n      {${esc(x.company)}}{${esc(x.location)}}\n`;
      if (x.bullets?.length) {
        body += '      \\resumeItemListStart\n';
        for (const b of x.bullets.slice(0, 4)) {
          body += `        \\resumeItem{${esc(b)}}\n`;
        }
        body += '      \\resumeItemListEnd\n';
      }
    }
    body += '  \\resumeSubHeadingListEnd\n\n';
  }

  if (sections.projects?.length) {
    body += '\n%-----------PROJECTS-----------\n\\section{Projects}\n    \\resumeSubHeadingListStart\n';
    for (const pr of sections.projects) {
      const left = pr.tech ? `{\\textbf{${esc(pr.name)}} $|$ \\emph{${esc(pr.tech)}}}` : `{\\textbf{${esc(pr.name)}}}`;
      body += `      \\resumeProjectHeading\n          {${left}}{${esc(pr.year)}}\n`;
      if (pr.bullets?.length) {
        body += '          \\resumeItemListStart\n';
        for (const b of pr.bullets.slice(0, 3)) {
          body += `            \\resumeItem{${esc(b)}}\n`;
        }
        body += '          \\resumeItemListEnd\n';
      }
    }
    body += '    \\resumeSubHeadingListEnd\n\n';
  }

  body += '\n%\n%-----------PROGRAMMING SKILLS-----------\n\\section{Technical Skills}\n \\begin{itemize}[leftmargin=0.15in, label={}]\n    \\small{\\item{\n';
  const groups = (sections.skillGroups || []).slice(0, 4);
  for (const g of groups) {
    body += `     \\textbf{${esc(g.label)}}{: ${esc(g.value)}} \\\\\n`;
  }
  body += '    }}\n \\end{itemize}\n\n%\n%-------------------------------------------\n\\end{document}\n';

  return PREAMBLE.replace('{{NAME}}', name).replace('{{HEADER}}', header) + body;
}

/** Split name/contact block from section list (built-in layout starts with \\begin{center}…\\end{center}). */
function splitResumeHeaderAndSections(inner) {
  const t = String(inner).trim();
  const bc = '\\begin{center}';
  const ec = '\\end{center}';
  const i0 = t.indexOf(bc);
  if (i0 === -1) return { resumeHeader: '', resumeSections: t };
  const i1 = t.indexOf(ec, i0);
  if (i1 === -1) return { resumeHeader: '', resumeSections: t };
  const headerEnd = i1 + ec.length;
  return {
    resumeHeader: t.slice(i0, headerEnd).trim(),
    resumeSections: t.slice(headerEnd).trim(),
  };
}

function preambleHasResumeSubheading(tex) {
  const b = tex.indexOf('\\begin{document}');
  const pre = b === -1 ? tex : tex.slice(0, b);
  return /\\newcommand\s*\{\\resumeSubheading\}/.test(pre);
}

function injectMacrosBeforeBeginDocument(tex, macros) {
  const mark = '\\begin{document}';
  const b = tex.indexOf(mark);
  if (b === -1) return `${macros}\n${tex}`;
  return `${tex.slice(0, b)}${macros}\n${tex.slice(b)}`;
}

/**
 * Merge profile LaTeX into an admin template.
 * Placeholders (spacing around names is optional):
 * - {{MACROS}} — built-in usepackage + \\resume* commands (put before \\begin{document}, or omit and we auto-insert when using SECTIONS/HEADER only).
 * - {{RESUME_HEADER}} — name + contact center block only (your layout can wrap or omit).
 * - {{RESUME_SECTIONS}} — Education / Experience / Projects / Skills only.
 * - {{BODY}} — full document inner (header + sections), same as before.
 * Do not mix {{BODY}} with {{RESUME_SECTIONS}} in the same file.
 */
function mergeTemplateWithBody(templateCode, fullInner, resumeHeader, resumeSections) {
  const tc = String(templateCode);
  const macros = (LATEX_RESUME_MACROS_BLOCK || '').trimEnd() + '\n';

  const hasMacrosPh = /\{\{\s*MACROS\s*\}\}/i.test(tc);
  const hasBodyPh = /\{\{\s*BODY\s*\}\}/i.test(tc);
  const hasSecPh = /\{\{\s*RESUME_SECTIONS\s*\}\}/i.test(tc);
  const hasHeadPh = /\{\{\s*RESUME_HEADER\s*\}\}/i.test(tc);

  let out = tc;
  if (hasMacrosPh) {
    out = out.replace(/\{\{\s*MACROS\s*\}\}/gi, macros);
  } else if ((hasSecPh || hasHeadPh) && !preambleHasResumeSubheading(out)) {
    out = injectMacrosBeforeBeginDocument(out, macros);
  }

  if (hasHeadPh) {
    out = out.replace(/\{\{\s*RESUME_HEADER\s*\}\}/gi, resumeHeader);
  }
  if (hasSecPh) {
    out = out.replace(/\{\{\s*RESUME_SECTIONS\s*\}\}/gi, resumeSections);
  }
  if (hasBodyPh) {
    out = out.replace(/\{\{\s*BODY\s*\}\}/gi, fullInner);
  }

  if (hasMacrosPh || hasBodyPh || hasSecPh || hasHeadPh) {
    return out;
  }

  const beginMark = '\\begin{document}';
  const endMark = '\\end{document}';
  const b = tc.indexOf(beginMark);
  const e = tc.indexOf(endMark);
  if (b !== -1 && e !== -1 && e > b) {
    const inner = tc.slice(b + beginMark.length, e).replace(/[\s\r\n%]|\\%/g, '').trim();
    if (inner.length < 8) {
      return `${tc.slice(0, e)}\n\n${fullInner}\n\n${tc.slice(e)}`;
    }
  }

  return null;
}

/**
 * @param user Mongoose User doc (profile populated)
 * @param {{ templateCode?: string }} [opts] optional full LaTeX from admin DB
 */
function buildLatexForUser(user, opts = {}) {
  const sections = mapUserToResumeSections(user);
  const full = buildLatexDocumentFromSections(sections);
  const tc = opts.templateCode?.trim();
  if (!tc) return full;

  const fullInner = full.split('\\begin{document}')[1]?.split('\\end{document}')[0]?.trim() || '';
  const { resumeHeader, resumeSections } = splitResumeHeaderAndSections(fullInner);
  const merged = mergeTemplateWithBody(tc, fullInner, resumeHeader, resumeSections);
  if (merged) return merged;

  return full;
}

module.exports = { buildLatexForUser, buildLatexDocumentFromSections, mapUserToResumeSections };
