'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const layout = require('../src/modules/layout.js');

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('weightStarts: cumulative ratios', () => {
    assert.deepEqual(layout.weightStarts([1, 1, 2]), [0, 0.25, 0.5]);
    assert.deepEqual(layout.weightStarts([0, 0]), [0, 0.5]);
    assert.deepEqual(layout.weightStarts([]), []);
});

test('computeLayout: measured items use pixel ratio when complete', () => {
    const { fractions } = layout.computeLayout(
        [{ weightStart: 0, pos: 0 }, { weightStart: 0.5, pos: 500 }],
        { height: 1000, complete: true }
    );
    close(fractions[0], 0);
    close(fractions[1], 0.5);
});

test('computeLayout: unmeasured items interpolate between measured anchors', () => {
    const { fractions } = layout.computeLayout(
        [
            { weightStart: 0.0, pos: 0 },
            { weightStart: 0.2, pos: null },
            { weightStart: 0.4, pos: 600 },
            { weightStart: 0.7, pos: null }
        ],
        { height: 1000, complete: true }
    );
    close(fractions[1], 0.3);      // 0 → 0.6 구간의 중간
    close(fractions[3], 0.8);      // 0.6 → 1 구간의 절반
});

test('computeLayout: without weights uses pixel ratio only', () => {
    const { fractions } = layout.computeLayout(
        [{ weightStart: null, pos: 250 }, { weightStart: null, pos: 750 }],
        { height: 1000 }
    );
    close(fractions[0], 0.25);
    close(fractions[1], 0.75);
});

test('computeLayout: incomplete (older turns not loaded) maps loaded region after loadedStart', () => {
    const res = layout.computeLayout(
        [
            { weightStart: 0.0, pos: null },
            { weightStart: 0.25, pos: null },
            { weightStart: 0.5, pos: 0 },
            { weightStart: 0.75, pos: 500 }
        ],
        { height: 1000, complete: false }
    );
    close(res.loadedStart, 0.5);
    close(res.fractions[0], 0);
    close(res.fractions[1], 0.25);
    close(res.fractions[2], 0.5);
    close(res.fractions[3], 0.75);
});

test('computeLayout: fractions never go backwards', () => {
    const { fractions } = layout.computeLayout(
        [{ weightStart: 0.1, pos: 800 }, { weightStart: 0.5, pos: 100 }, { weightStart: 0.9, pos: null }],
        { height: 1000, complete: true }
    );
    for (let i = 1; i < fractions.length; i++) assert.ok(fractions[i] >= fractions[i - 1]);
});

test('fractionToPixel: inverse of loaded region mapping', () => {
    close(layout.fractionToPixel(0.5, { height: 1000, loadedStart: 0 }), 500);
    close(layout.fractionToPixel(0.75, { height: 1000, loadedStart: 0.5 }), 500);
    assert.equal(layout.fractionToPixel(0.25, { height: 1000, loadedStart: 0.5 }), null);
});

test('medianShift: median of deltas', () => {
    assert.equal(layout.medianShift([]), 0);
    assert.equal(layout.medianShift([{ prev: 0, now: 100 }, { prev: 10, now: 110 }, { prev: 5, now: 6 }]), 100);
    assert.equal(layout.medianShift([{ prev: 0, now: 10 }, { prev: 0, now: 20 }]), 15);
});
