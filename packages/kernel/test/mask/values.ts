// Secret-shaped test values, built at run time so no fixture reads as a real number or key.

const mod97 = (digits: string) => [...digits].reduce((r, d) => (r * 10 + Number(d)) % 97, 0);

/** `body` with its Luhn check digit appended. */
export function luhn(body: string): string {
  let sum = 0;
  [...body].reverse().forEach((c, i) => {
    let d = Number(c) * (i % 2 === 0 ? 2 : 1);
    if (d > 9) d -= 9;
    sum += d;
  });
  return body + ((10 - (sum % 10)) % 10);
}

/** A French IBAN with computed check digits. */
export function iban(bban: string): string {
  const numeric = (bban + "FR00").replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  return `FR${String(98 - mod97(numeric)).padStart(2, "0")}${bban}`;
}

/** A NIR: 13 digits and their key. */
export const nir = (thirteen: string) => thirteen + String(97 - mod97(thirteen)).padStart(2, "0");

export const IBAN = iban("3000" + "6000" + "0112" + "3456" + "7890" + "189");
export const CARD = luhn("4970" + "1012" + "3456" + "789");
export const NIR = nir("1" + "85" + "05" + "78" + "006" + "084");
export const PHONE = "06" + "12" + "34" + "56" + "78";
export const CODE = "381" + "624";
export const API_KEY = "sk" + "_live_" + "51NxQk2LmN8pRs4TuVw6YzA8b";
export const TOKEN = "Zx8Kq2LmN9" + "pRs4TuVw6YzA8bCdEf";
export const PASSPORT = "18AB" + "34567";

/** Every run of 4 digits or more in `s`, digits of any script read as ASCII by NFKC. */
export const runs = (s: string) => s.normalize("NFKC").match(/\d{4,}/g) ?? [];

/** Each 4-digit window of `value`'s digits: none may survive in a masked output. */
export const windows = (value: string) => {
  const d = value.replace(/\D/g, "");
  return Array.from({ length: Math.max(0, d.length - 3) }, (_, i) => d.slice(i, i + 4));
};
