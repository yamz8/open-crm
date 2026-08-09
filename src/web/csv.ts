/**
 * A CSV reader and writer, written out rather than pulled in.
 *
 * Real exports from other CRMs are full of the awkward cases — commas inside
 * quoted names, newlines inside addresses, doubled quotes, a UTF-8 BOM from
 * Excel, CRLF line endings — and a naive `split(',')` mangles all of them
 * silently. Silently is the problem: a botched import looks like it worked.
 */

export type ParsedCsv = {
  headers: string[];
  /** Rows are padded or truncated to the header count so indexes always line up. */
  rows: string[][];
  /** Rows whose field count did not match the header, for reporting. */
  ragged: number;
};

/** RFC 4180 with the tolerances real files need. */
export function parseCsv(input: string, delimiter = ','): ParsedCsv {
  const text = input.replace(/^﻿/, ''); // Excel's byte-order mark
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let sawAnyChar = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'; // "" is an escaped quote
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field === '') {
      inQuotes = true;
      sawAnyChar = true;
      continue;
    }
    if (char === delimiter) {
      record.push(field);
      field = '';
      sawAnyChar = true;
      continue;
    }
    if (char === '\r') continue; // CRLF, or a lone CR
    if (char === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      sawAnyChar = false;
      continue;
    }
    field += char;
    sawAnyChar = true;
  }

  if (field !== '' || sawAnyChar || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  // Drop trailing blank lines, which almost every file ends with.
  while (records.length > 0) {
    const last = records[records.length - 1]!;
    if (last.length === 1 && last[0]!.trim() === '') records.pop();
    else break;
  }

  if (records.length === 0) return { headers: [], rows: [], ragged: 0 };

  const headers = records[0]!.map((h) => h.trim());
  let ragged = 0;
  const rows = records.slice(1).map((row) => {
    if (row.length !== headers.length) ragged++;
    const padded = row.slice(0, headers.length);
    while (padded.length < headers.length) padded.push('');
    return padded;
  });

  return { headers, rows, ragged };
}

/** Quote only when necessary, so the output stays readable in a text editor. */
export function toCsvValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const lines = [columns.map(toCsvValue).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => toCsvValue(row[c])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * Guesses which field a CSV column belongs to. Getting this right for the
 * common headings is what makes the mapping step a review rather than a chore.
 */
export function guessMapping(
  header: string,
  fields: { name: string; label: string }[],
): string | null {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = normalize(header);
  if (!target) return null;

  const aliases: Record<string, string[]> = {
    first_name: ['firstname', 'first', 'givenname', 'forename', 'fname'],
    last_name: ['lastname', 'last', 'surname', 'familyname', 'lname'],
    email: ['email', 'emailaddress', 'mail', 'primaryemail', 'workemail'],
    phone: ['phone', 'phonenumber', 'telephone', 'tel', 'mobile', 'cell'],
    title: ['title', 'jobtitle', 'position', 'role'],
    name: ['name', 'companyname', 'organization', 'organisation', 'account'],
    domain: ['domain', 'website', 'webdomain', 'url', 'site'],
    industry: ['industry', 'sector', 'vertical'],
    size: ['size', 'employees', 'headcount', 'companysize'],
    address: ['address', 'street', 'location', 'mailingaddress'],
    description: ['description', 'notes', 'note', 'comments', 'about'],
    linkedin_url: ['linkedin', 'linkedinurl', 'linkedinprofile'],
    lifecycle_stage: ['lifecyclestage', 'stage', 'status', 'lifecycle'],
    source: ['source', 'leadsource', 'origin', 'channel'],
    amount: ['amount', 'value', 'dealvalue', 'price', 'revenue'],
    close_date: ['closedate', 'expectedclose', 'closingdate'],
    due_at: ['due', 'duedate', 'dueat', 'deadline'],
    priority: ['priority', 'importance'],
  };

  for (const field of fields) {
    if (normalize(field.name) === target || normalize(field.label) === target) return field.name;
  }
  for (const field of fields) {
    if (aliases[field.name]?.includes(target)) return field.name;
  }
  return null;
}

export const SKIP_COLUMN = '__skip__';
export const CUSTOM_FIELD = '__custom__';

/**
 * Turns one CSV row into a record body using the chosen mapping.
 *
 * Blank cells are omitted rather than sent as empty strings, so an import never
 * overwrites a field with nothing. Amounts become minor units and bare dates
 * become timestamps, because that is what the API expects.
 */
export function rowToRecord(
  headers: string[],
  row: string[],
  mapping: Record<string, string>,
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  const properties: Record<string, unknown> = {};

  headers.forEach((header, i) => {
    const target = mapping[header] ?? SKIP_COLUMN;
    const raw = (row[i] ?? '').trim();
    if (target === SKIP_COLUMN || raw === '') return;

    if (target === CUSTOM_FIELD) {
      properties[header] = raw;
      return;
    }
    if (target === 'amount') {
      const amount = parseAmount(raw);
      if (amount !== null) record[target] = amount;
      return;
    }
    if (target === 'due_at') {
      const parsed = new Date(raw.length === 10 ? `${raw}T09:00:00` : raw);
      if (!Number.isNaN(parsed.getTime())) record[target] = parsed.toISOString();
      return;
    }
    record[target] = raw;
  });

  if (Object.keys(properties).length > 0) record['properties'] = properties;
  return record;
}

/**
 * Parses a spreadsheet amount into minor units, or null when it is not a number.
 *
 * Returning null rather than 0 matters: a cell reading "TBD" used to import as
 * $0.00, which looks like real data. Thousands and decimal separators are
 * genuinely ambiguous across locales, so the rule is "whichever separator comes
 * last is the decimal one", with a carve-out for the common `1,500` grouping.
 */
export function parseAmount(input: string): number | null {
  const cleaned = input.replace(/[^0-9.,-]/g, '').trim();
  if (cleaned === '' || !/[0-9]/.test(cleaned)) return null;

  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');
  let normalized: string;

  if (lastDot !== -1 && lastComma !== -1) {
    // Both present: the later one is the decimal point, the other groups digits.
    normalized =
      lastComma > lastDot
        ? cleaned.replace(/\./g, '').replace(',', '.')
        : cleaned.replace(/,/g, '');
  } else if (lastComma !== -1) {
    const decimals = cleaned.length - lastComma - 1;
    const singleComma = cleaned.indexOf(',') === lastComma;
    // "1,500" is a thousand; "1,50" is one and a half.
    normalized =
      singleComma && decimals === 3 ? cleaned.replace(',', '') : cleaned.replace(',', '.');
  } else {
    normalized = cleaned;
  }

  const value = Number(normalized);
  if (Number.isNaN(value)) return null;
  return Math.round(value * 100);
}
