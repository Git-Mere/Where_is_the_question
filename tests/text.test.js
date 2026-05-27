'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// text.js exposes module.exports when running in Node (dual-environment IIFE).
const text = require('../src/modules/text.js');

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------
test('escapeHtml: escapes all five special characters', () => {
    assert.equal(text.escapeHtml('&'), '&amp;');
    assert.equal(text.escapeHtml('<'), '&lt;');
    assert.equal(text.escapeHtml('>'), '&gt;');
    assert.equal(text.escapeHtml('"'), '&quot;');
    assert.equal(text.escapeHtml("'"), '&#39;');
});

test('escapeHtml: escapes a mixed HTML string', () => {
    assert.equal(
        text.escapeHtml('<script>alert("it\'s")</script>'),
        '&lt;script&gt;alert(&quot;it&#39;s&quot;)&lt;/script&gt;'
    );
});

test('escapeHtml: returns safe text unchanged', () => {
    assert.equal(text.escapeHtml('hello world'), 'hello world');
});

test('escapeHtml: coerces number to string', () => {
    assert.equal(text.escapeHtml(42), '42');
});

test('escapeHtml: empty string', () => {
    assert.equal(text.escapeHtml(''), '');
});

// ---------------------------------------------------------------------------
// normalizeFileName
// ---------------------------------------------------------------------------
test('normalizeFileName: empty / falsy returns empty string', () => {
    assert.equal(text.normalizeFileName(''), '');
    assert.equal(text.normalizeFileName(null), '');
    assert.equal(text.normalizeFileName(undefined), '');
});

test('normalizeFileName: file with a standard extension is returned unchanged', () => {
    assert.equal(text.normalizeFileName('report.pdf'), 'report.pdf');
    assert.equal(text.normalizeFileName('data.csv'), 'data.csv');
    assert.equal(text.normalizeFileName('REPORT.PDF'), 'REPORT.PDF');
});

test('normalizeFileName: strips leading [xxx icon] bracket token', () => {
    assert.equal(text.normalizeFileName('[pdf icon] report.pdf'), 'report.pdf');
    assert.equal(text.normalizeFileName('[FILE ICON] doc.docx'), 'doc.docx');
});

test('normalizeFileName: strips leading (xxx icon) paren token', () => {
    assert.equal(text.normalizeFileName('(file icon) report.txt'), 'report.txt');
});

test('normalizeFileName: strips leading word-icon prefix (e.g. "pdf icon")', () => {
    // "pdf icon" matches /^\s*[a-z0-9]+\s*icon\s*/i → stripped, leaving ''
    assert.equal(text.normalizeFileName('pdf icon'), '');
    // Prefix before a real filename
    assert.equal(text.normalizeFileName('pdf icon report.txt'), 'report.txt');
});

test('normalizeFileName: pure icon token returns empty string', () => {
    assert.equal(text.normalizeFileName('[some icon]'), '');
});

test('normalizeFileName: names without extension and <= 8 chars returned as-is', () => {
    // "readme" is 6 chars: maybeExt[1] = "readme" (6), cleaned.length (6) not > 6
    assert.equal(text.normalizeFileName('readme'), 'readme');
    // "document" is 8 chars: maybeExt[1] = "document" (8), not > 8
    assert.equal(text.normalizeFileName('document'), 'document');
});

test('normalizeFileName: trimmed whitespace', () => {
    assert.equal(text.normalizeFileName('  file.js  '), 'file.js');
});

// ---------------------------------------------------------------------------
// stripYouSaid
// ---------------------------------------------------------------------------
test('stripYouSaid: removes "you said:" (lowercase, with colon)', () => {
    const result = text.stripYouSaid('you said: hello world');
    // The match is replaced by a single space
    assert.equal(result.trim(), 'hello world');
});

test('stripYouSaid: removes "You Said:" (mixed case)', () => {
    const result = text.stripYouSaid('You Said: Hello');
    assert.equal(result.trim(), 'Hello');
});

test('stripYouSaid: removes "you said" without colon', () => {
    const result = text.stripYouSaid('you said hello');
    assert.equal(result.trim(), 'hello');
});

test('stripYouSaid: removes occurrence mid-string', () => {
    const result = text.stripYouSaid('I recall you said something');
    assert.ok(!result.includes('you said'));
});

test('stripYouSaid: no match leaves string unchanged', () => {
    assert.equal(text.stripYouSaid('just a question'), 'just a question');
});

test('stripYouSaid: empty string', () => {
    assert.equal(text.stripYouSaid(''), '');
});

// ---------------------------------------------------------------------------
// normalizePlainText
// ---------------------------------------------------------------------------
test('normalizePlainText: strips HTML tags', () => {
    assert.equal(text.normalizePlainText('<b>hello</b>'), 'hello');
});

test('normalizePlainText: collapses whitespace', () => {
    assert.equal(text.normalizePlainText('  hello   world  '), 'hello world');
});

test('normalizePlainText: strips tags and collapses whitespace together', () => {
    assert.equal(
        text.normalizePlainText('<div>line1</div> <div>line2</div>'),
        'line1 line2'
    );
});

test('normalizePlainText: empty string', () => {
    assert.equal(text.normalizePlainText(''), '');
});

test('normalizePlainText: only tags returns empty string', () => {
    assert.equal(text.normalizePlainText('<br><hr>'), '');
});

// ---------------------------------------------------------------------------
// hashString
// ---------------------------------------------------------------------------
test('hashString: empty string produces deterministic base-36 value', () => {
    // hash = 5381 (djb2 seed), no iterations → (5381 >>> 0).toString(36) = "45h"
    assert.equal(text.hashString(''), '45h');
});

test('hashString: same input always produces same hash (stability)', () => {
    const input = 'What is the capital of France?';
    assert.equal(text.hashString(input), text.hashString(input));
});

test('hashString: different inputs produce different hashes', () => {
    assert.notEqual(text.hashString('hello'), text.hashString('world'));
    assert.notEqual(text.hashString('question one'), text.hashString('question two'));
});

test('hashString: result is a non-empty string', () => {
    const h = text.hashString('test');
    assert.equal(typeof h, 'string');
    assert.ok(h.length > 0);
});

test('hashString: result is valid base-36 (only 0-9 and a-z)', () => {
    const h = text.hashString('hello world');
    assert.match(h, /^[0-9a-z]+$/);
});

test('hashString: collision suffix scenario - identical text produces same base hash', () => {
    // Two elements with the same plain text should share the same base hash,
    // so the ID disambiguation (-0, -1, …) logic in generateQuestionId works correctly.
    const h1 = text.hashString(text.normalizePlainText('Tell me a joke'));
    const h2 = text.hashString(text.normalizePlainText('Tell me a joke'));
    assert.equal(h1, h2);
});

test('hashString: whitespace-equivalent text (after normalizePlainText) yields same hash', () => {
    const a = text.hashString(text.normalizePlainText('  hello  world  '));
    const b = text.hashString(text.normalizePlainText('hello world'));
    assert.equal(a, b);
});
