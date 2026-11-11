import assert from 'node:assert/strict';
import test from 'node:test';

import { chooseModel, coveringLimits, parseModels, parseUsage, TIERS } from '../../scripts/lib/quota.mjs';

const USAGE = [
  'Gemini Models\tWeekly Limit Remaining\t79%\t2026-11-14T09:54:37Z',
  'Gemini Models\tFive Hour Limit Remaining\t100%\t2026-11-11T12:19:54Z',
  'Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-11-17T16:40:15Z',
  'Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-11-11T12:19:54Z',
  'Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t0%\t2026-11-14T04:30:48Z',
].join('\n');

const MODELS = [
  'Fetching available models...',
  'gemini-4-argon-medium\tGemini 4 Argon (Medium)',
  'gemini-4-argon-high\tGemini 4 Argon (High)',
  'gemini-4-argon-low\tGemini 4 Argon (Low)',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'claude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)',
  'claude-sonnet-5-5-medium\tClaude Sonnet 5.5 (Medium)',
  'claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)',
  'claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
].join('\n');

test('usage lines parse into limits with percentages and reset times', () => {
  const limits = parseUsage(USAGE);
  assert.equal(limits.length, 5);
  assert.deepEqual(limits[4], { label: 'Gemini 4 Argon', window: 'Gemini 4 Argon Weekly Limit', remaining: 0, resetAt: '2026-11-14T04:30:48Z' });
});

test('model lines parse and the progress line is ignored', () => {
  const models = parseModels(MODELS);
  assert.equal(models.length, 11);
  assert.deepEqual(models[0], { slug: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' });
});

test('a model is covered by its pool and by any limit of its own', () => {
  const limits = parseUsage(USAGE);
  const argon = { slug: 'gemini-4-argon-low', name: 'Gemini 4 Argon (Low)' };
  assert.deepEqual(coveringLimits(argon, limits).map((limit) => limit.label), ['Gemini Models', 'Gemini Models', 'Gemini 4 Argon']);
  const sonnet = { slug: 'claude-sonnet-5-5-medium', name: 'Claude Sonnet 5.5 (Medium)' };
  assert.deepEqual(coveringLimits(sonnet, limits).map((limit) => limit.label), ['Claude and GPT models', 'Claude and GPT models']);
});

test('the standard tier skips a model whose own limit is spent and prefers the pool with more room', () => {
  const choice = chooseModel({ tier: 'standard', models: parseModels(MODELS), limits: parseUsage(USAGE) });
  assert.equal(choice.slug, 'claude-sonnet-5-5-medium');
});

test('with every standard model spent there is no choice and no move up a tier', () => {
  const spent = USAGE.replace(/\t\d+%\t/g, '\t0%\t');
  const choice = chooseModel({ tier: 'standard', models: parseModels(MODELS), limits: parseUsage(spent) });
  assert.equal(choice, null);
});

test('a slug the account does not list is never chosen', () => {
  const choice = chooseModel({ tier: 'light', models: [{ slug: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' }], limits: parseUsage(USAGE) });
  assert.equal(choice.slug, 'gemini-3.8-flash-low');
});

test('every tier names known slugs', () => {
  assert.deepEqual(Object.keys(TIERS), ['light', 'standard', 'heavy']);
});
