/**
 * Checks that tell a real identifier from a number that only looks like one. Every detector of card
 * numbers and account numbers uses them, so an order id or a millisecond timestamp is never masked as
 * a card.
 */

/** Whether a card number passes the Luhn check, with 13 to 19 digits; spaces and dashes are ignored. */
export function luhn(value: string): boolean {
  const digits = value.replace(/[\s-]/g, '');
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** Whether an IBAN passes its mod-97 check, with 15 to 34 characters; spaces are ignored. */
export function ibanChecksum(value: string): boolean {
  const iban = value.replace(/ /g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`;
  let remainder = 0;
  for (const char of rearranged) {
    const code = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of code) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/** Whether a phone-like match has as many digits as a phone number can: 10 to 15. */
export function phoneDigits(value: string): boolean {
  const digits = value.replace(/\D/g, '').length;
  return digits >= 10 && digits <= 15;
}

/**
 * Whether a match reads as a phone number: 10 to 15 digits, written with a leading `+` or with
 * separators. A bare run of digits is an id or a timestamp far more often than a phone number.
 */
export function phoneNumber(value: string): boolean {
  return phoneDigits(value) && (/^\s*\+/.test(value) || /\d[\s.()-]+\d/.test(value));
}

/**
 * Text as a detector should read it: Unicode compatibility forms folded (full-width letters become
 * ASCII), and the invisible characters an attacker uses to split a phrase removed, so
 * `ｉｇｎｏｒｅ` and `ig​nore` read as `ignore`.
 */
export function normalizeForDetection(text: string): string {
  return text.normalize('NFKC').replace(/[­᠎​-‏‪-‮⁠-⁤﻿]/g, '');
}
