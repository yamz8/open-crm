import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCsv,
  toCsv,
  toCsvValue,
  guessMapping,
  rowToRecord,
  SKIP_COLUMN,
  CUSTOM_FIELD,
  parseAmount,
} from './csv.ts';

/**
 * The cases here are the ones that appear in real exports from other CRMs and
 * from Excel. A parser that fails any of them corrupts an import quietly, which
 * is worse than refusing the file outright.
 */

describe('parsing', () => {
  test('reads a plain file', () => {
    const { headers, rows, ragged } = parseCsv('first,last\nAda,Lovelace\nAlan,Turing\n');
    assert.deepEqual(headers, ['first', 'last']);
    assert.deepEqual(rows, [
      ['Ada', 'Lovelace'],
      ['Alan', 'Turing'],
    ]);
    assert.equal(ragged, 0);
  });

  test('keeps commas inside quoted fields', () => {
    const { rows } = parseCsv('name,address\n"Acme, Inc.","1 Main St, Springfield"\n');
    assert.deepEqual(rows[0], ['Acme, Inc.', '1 Main St, Springfield']);
  });

  test('keeps newlines inside quoted fields', () => {
    const { rows } = parseCsv('name,notes\n"Acme","line one\nline two"\nOther,x\n');
    assert.equal(rows.length, 2, 'the embedded newline must not split the record');
    assert.equal(rows[0]![1], 'line one\nline two');
    assert.deepEqual(rows[1], ['Other', 'x']);
  });

  test('unescapes doubled quotes', () => {
    const { rows } = parseCsv('name\n"She said ""hello"""\n');
    assert.equal(rows[0]![0], 'She said "hello"');
  });

  test('handles CRLF endings', () => {
    const { headers, rows } = parseCsv('a,b\r\n1,2\r\n3,4\r\n');
    assert.deepEqual(headers, ['a', 'b']);
    assert.deepEqual(rows, [
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  test('strips the Excel byte-order mark', () => {
    const { headers } = parseCsv('﻿email,name\nx@example.com,X\n');
    assert.deepEqual(
      headers,
      ['email', 'name'],
      'the BOM must not become part of the first header',
    );
  });

  test('does not require a trailing newline', () => {
    const { rows } = parseCsv('a,b\n1,2');
    assert.deepEqual(rows, [['1', '2']]);
  });

  test('ignores trailing blank lines', () => {
    const { rows } = parseCsv('a,b\n1,2\n\n\n');
    assert.equal(rows.length, 1);
  });

  test('pads and reports ragged rows instead of misaligning them', () => {
    const { rows, ragged } = parseCsv('a,b,c\n1,2\n1,2,3,4\n');
    assert.deepEqual(rows[0], ['1', '2', '']);
    assert.deepEqual(rows[1], ['1', '2', '3']);
    assert.equal(ragged, 2);
  });

  test('preserves empty fields', () => {
    const { rows } = parseCsv('a,b,c\n1,,3\n');
    assert.deepEqual(rows[0], ['1', '', '3']);
  });

  test('an empty file yields nothing rather than throwing', () => {
    assert.deepEqual(parseCsv(''), { headers: [], rows: [], ragged: 0 });
    assert.deepEqual(parseCsv('\n').rows, []);
  });

  test('a header-only file has columns but no rows', () => {
    const { headers, rows } = parseCsv('email,name\n');
    assert.deepEqual(headers, ['email', 'name']);
    assert.equal(rows.length, 0);
  });

  test('supports semicolon-delimited exports', () => {
    const { headers, rows } = parseCsv('a;b\n1;2\n', ';');
    assert.deepEqual(headers, ['a', 'b']);
    assert.deepEqual(rows[0], ['1', '2']);
  });
});

describe('writing', () => {
  test('quotes only what needs quoting', () => {
    assert.equal(toCsvValue('plain'), 'plain');
    assert.equal(toCsvValue('has,comma'), '"has,comma"');
    assert.equal(toCsvValue('has"quote'), '"has""quote"');
    assert.equal(toCsvValue('has\nnewline'), '"has\nnewline"');
    assert.equal(toCsvValue(null), '');
    assert.equal(toCsvValue(undefined), '');
    assert.equal(toCsvValue(42), '42');
  });

  test('serializes objects rather than emitting [object Object]', () => {
    assert.equal(toCsvValue({ score: 1 }), '"{""score"":1}"');
  });

  test('round-trips through the parser', () => {
    const rows = [
      { name: 'Acme, Inc.', notes: 'line one\nline two', email: 'a@example.com' },
      { name: 'She said "hi"', notes: '', email: null },
    ];
    const parsed = parseCsv(toCsv(rows, ['name', 'notes', 'email']));
    assert.deepEqual(parsed.headers, ['name', 'notes', 'email']);
    assert.deepEqual(parsed.rows[0], ['Acme, Inc.', 'line one\nline two', 'a@example.com']);
    assert.deepEqual(parsed.rows[1], ['She said "hi"', '', '']);
  });
});

describe('column guessing', () => {
  const contactFields = [
    { name: 'first_name', label: 'First name' },
    { name: 'last_name', label: 'Last name' },
    { name: 'email', label: 'Email' },
    { name: 'phone', label: 'Phone' },
    { name: 'title', label: 'Job title' },
  ];

  test('matches the headings other tools actually emit', () => {
    const cases: [string, string][] = [
      ['First Name', 'first_name'],
      ['first_name', 'first_name'],
      ['Given Name', 'first_name'],
      ['Surname', 'last_name'],
      ['E-mail Address', 'email'],
      ['Work Email', 'email'],
      ['Mobile', 'phone'],
      ['Job Title', 'title'],
    ];
    for (const [header, expected] of cases) {
      assert.equal(guessMapping(header, contactFields), expected, `"${header}"`);
    }
  });

  test('returns null when it genuinely does not know', () => {
    assert.equal(guessMapping('Favourite Colour', contactFields), null);
    assert.equal(guessMapping('', contactFields), null);
    assert.equal(guessMapping('   ', contactFields), null);
  });
});

describe('row to record', () => {
  const headers = ['First Name', 'Email', 'Ignore Me', 'Score'];
  const mapping = {
    'First Name': 'first_name',
    Email: 'email',
    'Ignore Me': SKIP_COLUMN,
    Score: CUSTOM_FIELD,
  };

  test('applies the mapping and routes custom columns to properties', () => {
    const record = rowToRecord(headers, ['Ada', 'ada@example.com', 'junk', '91'], mapping);
    assert.deepEqual(record, {
      first_name: 'Ada',
      email: 'ada@example.com',
      properties: { Score: '91' },
    });
  });

  test('omits blank cells rather than sending empty strings', () => {
    const record = rowToRecord(headers, ['Ada', '', 'junk', ''], mapping);
    assert.deepEqual(record, { first_name: 'Ada' }, 'a blank cell must not clear a field');
    assert.ok(!('properties' in record), 'no custom values means no properties key');
  });

  test('trims surrounding whitespace', () => {
    const record = rowToRecord(headers, ['  Ada  ', ' ada@example.com ', '', ''], mapping);
    assert.equal(record['first_name'], 'Ada');
    assert.equal(record['email'], 'ada@example.com');
  });

  test('converts amounts to minor units, tolerating currency symbols', () => {
    const m = { Amount: 'amount' };
    assert.equal(rowToRecord(['Amount'], ['1500'], m)['amount'], 150000);
    assert.equal(rowToRecord(['Amount'], ['$1,500.50'], m)['amount'], 150050);
    assert.equal(
      rowToRecord(['Amount'], ['not a number'], m)['amount'],
      undefined,
      'a non-numeric cell must be omitted, never imported as zero',
    );
  });

  test('turns a bare date into a timestamp the API accepts', () => {
    const due = rowToRecord(['Due'], ['2026-12-31'], { Due: 'due_at' })['due_at'];
    assert.match(String(due), /^2026-12-31T/);
  });

  test('a fully unmapped row produces nothing to send', () => {
    const record = rowToRecord(headers, ['a', 'b', 'c', 'd'], {
      'First Name': SKIP_COLUMN,
      Email: SKIP_COLUMN,
      'Ignore Me': SKIP_COLUMN,
      Score: SKIP_COLUMN,
    });
    assert.deepEqual(record, {});
  });
});

describe('amount parsing', () => {
  test('handles the formats spreadsheets actually contain', () => {
    const cases: [string, number | null][] = [
      ['1500', 150000],
      ['1,500', 150000], // en thousands
      ['1,500.50', 150050],
      ['$1,500.50', 150050],
      ['€1.500,50', 150050], // de/fr grouping with decimal comma
      ['1.234,56', 123456],
      ['1,50', 150], // decimal comma, no grouping
      ['0.99', 99],
      ['-250', -25000],
      ['  42  ', 4200],
    ];
    for (const [input, expected] of cases) {
      assert.equal(parseAmount(input), expected, `"${input}"`);
    }
  });

  test('refuses non-numbers instead of importing them as zero', () => {
    for (const input of ['', '   ', 'TBD', 'n/a', '-', '$', 'unknown']) {
      assert.equal(parseAmount(input), null, `"${input}" must not become 0`);
    }
  });
});
