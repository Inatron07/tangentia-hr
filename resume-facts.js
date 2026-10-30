// Pulls quick facts (experience, CTC, notice period) out of a resume file.
// Text extraction: PDF via unpdf, DOCX via mammoth, plain text as-is.
// Facts: explicit statements first ("Total experience: 5 years", "Expected CTC: 12 LPA");
// if no experience is stated, a rough estimate from the job date ranges, flagged as such.

export async function resumeText(buffer, filename = '') {
  const name = filename.toLowerCase();
  const head = Buffer.from(buffer.slice(0, 5)).toString('latin1');
  if (head.startsWith('%PDF')) {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: true });
    return text || '';
  }
  if (name.endsWith('.docx') || head.startsWith('PK')) {
    const mammoth = (await import('mammoth')).default;
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(buffer) });
    return value || '';
  }
  if (name.endsWith('.txt') || name.endsWith('.rtf')) return Buffer.from(buffer).toString('utf8');
  return ''; // .doc and other formats: not supported
}

const NUM = '(\\d{1,2}(?:\\.\\d{1,2})?)';
const YRS = '(?:\\+\\s*)?(?:years?|yrs?)';

export function parseFacts(raw, now = new Date()) {
  const text = String(raw || '').replace(/\r/g, '').replace(/[ \t ]+/g, ' ');
  const facts = { experience: null, experience_estimated: false, current_ctc: null, expected_ctc: null, notice: null };
  if (!text.trim()) return facts;

  // ---- experience, stated
  const expPatterns = [
    // "Total experience: 5 years 6 months" / "Experience - 4.5 yrs"
    new RegExp(`(?:total|overall|relevant|professional|work|it|industry)?\\s*experience\\s*(?:of)?\\s*[:\\-–]?\\s*${NUM}\\s*${YRS}(?:\\s*(?:and\\s*)?(\\d{1,2})\\s*months?)?`, 'i'),
    // "5+ years of experience" / "6 yrs of IT experience"
    new RegExp(`${NUM}\\s*${YRS}\\s*(?:of\\s*)?(?:total\\s*|overall\\s*|rich\\s*|hands[- ]on\\s*|professional\\s*|relevant\\s*|it\\s*|industry\\s*|work\\s*)*(?:experience|exp\\b)`, 'i'),
  ];
  for (const re of expPatterns) {
    const m = text.match(re);
    if (m) {
      const years = Number(m[1]);
      if (years > 0 && years < 45) {
        const months = m[2] ? Number(m[2]) : 0;
        facts.experience = months ? `${years} yrs ${months} mo` : `${years} yrs`;
        break;
      }
    }
  }
  if (!facts.experience) {
    const m = text.match(/(\d{1,2})\s*months?\s*(?:of\s*)?(?:total\s*|work\s*|professional\s*)?experience/i);
    if (m && Number(m[1]) > 0 && Number(m[1]) < 36) facts.experience = `${Number(m[1])} months`;
  }
  if (/\bfresher\b/i.test(text) && !facts.experience) facts.experience = 'Fresher';

  // ---- experience, estimated from date ranges like "Jan 2019 - Present" or "2017 – 2021"
  if (!facts.experience) {
    const month = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
    const range = new RegExp(`(?:${month}\\s*['’]?)?((?:19|20)\\d{2})\\s*(?:-|–|—|to|till)\\s*(?:(?:${month}\\s*['’]?)?((?:19|20)\\d{2})|(present|current|now|till date|date|ongoing))`, 'gi');
    let start = Infinity, end = -Infinity, m, count = 0;
    const eduWords = /\b(b\.?\s?e\b|b\.?\s?tech|m\.?\s?tech|b\.?\s?sc|m\.?\s?sc|bca|mca|mba|b\.?\s?com|degree|university|college|school|ssc|hsc|cbse|education|bachelor|master|diploma|cgpa|gpa|graduat)/i;
    while ((m = range.exec(text))) {
      const ctx = text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 30);
      const line = ctx.split('\n').find((l) => l.includes(m[0].slice(0, 8))) || ctx;
      if (eduWords.test(line)) continue;
      const s = Number(m[1]);
      const e = m[3] ? now.getFullYear() : Number(m[2]);
      if (s >= 1980 && e >= s && e <= now.getFullYear() && e - s <= 40) {
        start = Math.min(start, s); end = Math.max(end, e); count++;
      }
    }
    // Only trust it when it does not look like the education section alone.
    const hasWorkWords = /\b(experience|employment|work history|company|pvt|ltd|limited|technologies|solutions|developer|engineer|analyst|consultant)\b/i.test(text);
    if (count && hasWorkWords && Number.isFinite(start)) {
      const yrs = end - start;
      if (yrs >= 1 && yrs < 45) { facts.experience = `~${yrs} yrs`; facts.experience_estimated = true; }
    }
  }

  // ---- CTC / salary
  const money = (label) => {
    const re = new RegExp(`${label}\\s*(?:ctc|salary|package|compensation|pay)?\\s*(?:\\(.*?\\))?\\s*[:\\-–=]?\\s*([^\\n]{1,60})`, 'i');
    const m = text.match(re);
    if (!m) return null;
    const v = cleanMoney(m[1]);
    return v;
  };
  facts.current_ctc = money('(?:current|present|existing)\\s*(?=ctc|salary|package|compensation|pay)');
  facts.expected_ctc = money('(?:expected|desired)\\s*(?=ctc|salary|package|compensation|pay)');

  // ---- notice period
  const n = text.match(/notice\s*period\s*(?:of)?\s*[:\-–]?\s*([^\n]{1,40})/i);
  if (n) facts.notice = cleanShort(n[1]);
  if (!facts.notice && /\bimmediate(?:ly)?\s*(?:joiner|joining|available)\b/i.test(text)) facts.notice = 'Immediate';

  return facts;
}

function cleanMoney(s) {
  let v = String(s).trim();
  // stop at the next field label on the same line
  v = v.split(/\s{2,}|\s(?:expected|current|notice|location|email|phone|mobile|dob|date)\b/i)[0];
  v = v.replace(/^[:\-–=\s]+/, '').replace(/[|,;.\s]+$/, '');
  if (!/\d/.test(v) && !/negotiable|as per|nil|na\b/i.test(v)) return null;
  return v.length > 40 ? v.slice(0, 40).trim() + '…' : v || null;
}
function cleanShort(s) {
  let v = String(s).trim().split(/\s{2,}|\s(?:expected|current|location|email|phone|mobile)\b/i)[0];
  v = v.replace(/^[:\-–=\s]+/, '').replace(/[|,;.\s]+$/, '');
  return v ? (v.length > 30 ? v.slice(0, 30).trim() + '…' : v) : null;
}
