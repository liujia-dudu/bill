// Structural checks only; the invoice page supplies the company-to-code association.
export function validCreditCode(code) {
  if (!/^[0-9A-HJ-NPQRTUWXY]{18}$/.test(code)) return false;
  const alphabet = '0123456789ABCDEFGHJKLMNPQRTUWXY';
  const weights = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
  const total = weights.reduce(
    (sum, weight, index) => sum + alphabet.indexOf(code[index]) * weight,
    0,
  );
  return alphabet[(31 - (total % 31)) % 31] === code[17];
}
export function validPageTaxId(code) {
  return /^(?:[A-Z0-9]{15}|[A-Z0-9]{20})$/.test(code) || validCreditCode(code);
}
export const companyNameKey = (value) => String(value).normalize('NFKC').replace(/\s+/g, '');
export function pageCompanyCandidate(text) {
  const codes = [
    ...new Set(text.toUpperCase().match(/(?<![A-Z0-9])[A-Z0-9]{15,20}(?![A-Z0-9])/g) || []),
  ];
  if (codes.length > 1) return null;
  const taxId = codes[0] || '';
  const title = text
    .replace(taxId, '')
    .replace(/统一社会信用代码|纳税人识别号|税号/g, '')
    .replace(/[|｜:：\s]+/g, ' ')
    .trim();
  return { title, taxId };
}
