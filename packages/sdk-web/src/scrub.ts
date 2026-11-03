/** Mask credentials that could end up in an error message or stack. */
export function scrub(s: string): string {
  return s
    .replace(/\bBearer\s+[\w.~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[REDACTED]')
    .replace(/\b(?:pk|sk)_(?:dev|staging|prod)_[0-9A-Za-z]+/g, '[REDACTED]');
}

/** URLs inside free text lose their query string and fragment (they can carry tokens or PII). */
export const stripUrlQueries = (s: string) => s.replace(/(\bhttps?:\/\/[^\s?#'"()<>]+)[?#][^\s'"()<>]*/g, '$1');

/** origin + pathname of a URL string; '' when it does not parse. */
export function originPath(u: string | null | undefined): string {
  if (!u) return '';
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname}`;
  } catch {
    return '';
  }
}
