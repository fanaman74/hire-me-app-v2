export const DEFAULT_CV_FORMAT = 'chronological';

export const CV_FORMATS = Object.freeze({
  chronological: Object.freeze({
    id: 'chronological',
    label: 'Reverse chronological',
    description: 'Conventional CV with the most recent experience first.',
    instruction: 'Use a conventional reverse chronological CV: a concise role-specific profile, relevant skills, professional experience with the most recent role first, then education and certifications. Keep the candidate’s existing employers, titles, dates, responsibilities, achievements, and metrics unchanged unless the source supports an honest wording improvement.',
  }),
  combination: Object.freeze({
    id: 'combination',
    label: 'Skills-based / combination',
    description: 'Lead with evidenced capabilities, then show the employment timeline.',
    instruction: 'Use a skills-based combination CV: lead with a role-specific profile and grouped core competencies, support each important competency with evidence from the original CV, include selected evidence-based achievements or projects, then show the complete employment timeline and education/certifications. Do not turn an unsupported requirement into a claimed skill.',
  }),
  europass: Object.freeze({
    id: 'europass',
    label: 'Europass-style structured CV',
    description: 'Use familiar Europass-style sections in editable Markdown; this is not an official export.',
    instruction: 'Use a Europass-style structured CV in editable Markdown, not an official Europass export. Use only evidenced sections, such as personal/contact details when supplied, work experience, education and training, language skills, digital skills, other skills/activities, and additional information. Do not invent personal data, CEFR language levels, digital-skill levels, dates, or sections that are unsupported.',
  }),
});

export function isCvFormat(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CV_FORMATS, value);
}

export function normalizeCvFormat(value) {
  return isCvFormat(value) ? value : DEFAULT_CV_FORMAT;
}

export function cvFormatDetails(value) {
  return CV_FORMATS[normalizeCvFormat(value)];
}
