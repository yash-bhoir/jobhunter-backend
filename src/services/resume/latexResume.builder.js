const { mapUserToResumeSections, latexEscape } = require('./resumeContent.mapper');

const PREAMBLE = String.raw`%-------------------------
% Auto-generated — Jake Gutierrez style (sb2nov)
%------------------------

\documentclass[letterpaper,10.5pt]{article}

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

\pagestyle{fancy}
\fancyhf{}
\fancyfoot{}
\renewcommand{\headrulewidth}{0pt}
\renewcommand{\footrulewidth}{0pt}

\addtolength{\oddsidemargin}{-0.5in}
\addtolength{\evensidemargin}{-0.5in}
\addtolength{\textwidth}{1in}
\addtolength{\topmargin}{-.55in}
\addtolength{\textheight}{1.05in}

\urlstyle{same}
\raggedbottom
\raggedright
\setlength{\tabcolsep}{0in}

\titleformat{\section}{
  \vspace{-5pt}\scshape\raggedright\large
}{}{0em}{}[\color{black}\titlerule \vspace{-5pt}]

\pdfgentounicode=1

\newcommand{\resumeItem}[1]{\item\small{{#1 \vspace{-2pt}}}}
\newcommand{\resumeSubheading}[4]{
  \vspace{-2pt}\item
    \begin{tabular*}{0.97\textwidth}[t]{l@{\extracolsep{\fill}}r}
      \textbf{#1} & #2 \\
      \textit{\small#3} & \textit{\small #4} \\
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
\newcommand{\resumeItemListStart}{\begin{itemize}[topsep=0pt,itemsep=0pt]}
\newcommand{\resumeItemListEnd}{\end{itemize}\vspace{-5pt}}

\begin{document}

\begin{center}
    \textbf{\Huge \scshape {{NAME}}} \\ \vspace{1pt}
    \small {{HEADER}}
\end{center}

`;

function buildLatexDocumentFromSections(sections) {
  const esc = latexEscape;
  const name = esc(sections.name);
  const headerBits = [];
  if (sections.phone) headerBits.push(esc(sections.phone));
  if (sections.email) headerBits.push(`\\href{mailto:${esc(sections.email)}}{\\underline{${esc(sections.email)}}}`);
  if (sections.city) headerBits.push(esc(sections.city));
  if (sections.linkedin) headerBits.push(`\\href{${esc(sections.linkedin)}}{\\underline{${esc(sections.linkedin)}}}`);
  const header = headerBits.join(' $|$ ');

  let body = '';

  if (sections.education?.length) {
    body += '\\section{Education}\n  \\resumeSubHeadingListStart\n';
    for (const e of sections.education) {
      body += `    \\resumeSubheading\n      {${esc(e.school)}}{${esc(e.location)}}\n      {${esc(e.degree)}}{${esc(e.dates)}}\n`;
    }
    body += '  \\resumeSubHeadingListEnd\n\n';
  }

  if (sections.experience?.length) {
    body += '\\section{Experience}\n  \\resumeSubHeadingListStart\n';
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
    body += '\\section{Projects}\n    \\resumeSubHeadingListStart\n';
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

  body += '\\section{Technical Skills}\n \\begin{itemize}[leftmargin=0.15in, label={}]\n    \\small{\\item{\n';
  for (const g of sections.skillGroups.slice(0, 4)) {
    body += `     \\textbf{${esc(g.label)}}{: ${esc(g.value)}} \\\\\n`;
  }
  body += '    }}\n \\end{itemize}\n\n\\end{document}\n';

  return PREAMBLE.replace('{{NAME}}', name).replace('{{HEADER}}', header) + body;
}

/**
 * @param user Mongoose User doc (profile populated)
 * @param {{ templateCode?: string }} [opts] optional full LaTeX from admin DB — must contain {{BODY}} or we append
 */
function buildLatexForUser(user, opts = {}) {
  const sections = mapUserToResumeSections(user);
  if (opts.templateCode && opts.templateCode.includes('{{BODY}}')) {
    const full = buildLatexDocumentFromSections(sections);
    const core = full.split('\\begin{document}')[1]?.split('\\end{document}')[0]?.trim() || '';
    return opts.templateCode.replace(/\{\{BODY\}\}/g, core);
  }
  return buildLatexDocumentFromSections(sections);
}

module.exports = { buildLatexForUser, buildLatexDocumentFromSections, mapUserToResumeSections };
