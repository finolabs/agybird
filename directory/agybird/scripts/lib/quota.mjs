// Quota-aware model choice. `agy -p /usage` reports limits per pool and per
// model without starting a model turn; `agy models` lists the slugs this
// account can use. The tier table is a starting heuristic (references/models.md).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { resolveAgyBinary } from '../agybird.mjs';

export const TIERS = {
  light: ['gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'claude-sonnet-5-5-low', 'gpt-oss-120b-medium'],
  standard: ['gemini-3.8-flash-high', 'gemini-4-argon-low', 'gemini-4-argon-medium', 'claude-sonnet-5-5-medium'],
  heavy: ['gemini-4-argon-high', 'claude-sonnet-5-5-high', 'claude-opus-5-5-medium', 'claude-opus-5-5-high'],
};
// Below this a pool is nearly empty; another pool with more room is preferred.
const NEARLY_EMPTY = 10;
const CACHE_MS = 5 * 60_000;

export function parseUsage(text) {
  const limits = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const [label, window, percent, resetAt] = line.split('\t');
    const match = /^(\d{1,3})%$/.exec(percent?.trim() ?? '');
    if (!label || !window || !match) continue;
    limits.push({ label: label.trim(), window: window.trim(), remaining: Number(match[1]), resetAt: resetAt?.trim() ?? null });
  }
  return limits;
}

export function parseModels(text) {
  const models = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const [slug, name] = line.split('\t');
    if (!slug || !name || !/^[a-z0-9][a-z0-9.-]*$/.test(slug.trim())) continue;
    models.push({ slug: slug.trim(), name: name.trim() });
  }
  return models;
}

// The limits that apply to one model: its shared pool, read from the pool
// labels agy prints, plus any limit named after the model itself.
export function coveringLimits(model, limits) {
  return limits.filter((limit) => {
    if (limit.label === 'Gemini Models') return model.slug.startsWith('gemini-');
    if (limit.label === 'Claude and GPT models') return model.slug.startsWith('claude-') || model.slug.startsWith('gpt-');
    return model.name.startsWith(limit.label);
  });
}

function room(model, limits) {
  const covering = coveringLimits(model, limits);
  return covering.length === 0 ? null : Math.min(...covering.map((limit) => limit.remaining));
}

// Ranks a candidate: known room above the nearly-empty line, then any known
// room, then a model the report says nothing about (room unknown, not spent).
function rank(entry) {
  if (entry.room === null) return 1;
  return entry.room >= NEARLY_EMPTY ? 3 : 2;
}

// The usable model of one tier with the most room, never one from another tier.
// Only a limit reported at 0% rules a model out; a model the report leaves out
// stays a candidate with room null.
export function chooseModel({ tier, models, limits }) {
  const candidates = TIERS[tier];
  if (!candidates) throw new Error(`Unknown tier: ${tier}`);
  const listed = new Map(models.map((model) => [model.slug, model]));
  const scored = candidates
    .map((slug, order) => ({ model: listed.get(slug), order }))
    .filter((entry) => entry.model)
    .map((entry) => ({ ...entry, room: room(entry.model, limits) }))
    .filter((entry) => entry.room === null || entry.room > 0);
  scored.sort((a, b) => (rank(b) - rank(a)) || ((b.room ?? 0) - (a.room ?? 0)) || (a.order - b.order));
  return scored[0] ? { ...scored[0].model, room: scored[0].room } : null;
}

function runAgy(args, { cwd, env }) {
  const binary = resolveAgyBinary(env);
  const result = spawnSync(binary.command, [...binary.prefixArgs, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 30_000,
    shell: false,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`agy ${args.join(' ')} failed: ${String(result.stderr || result.error?.message || '').trim().slice(0, 200)}`);
  }
  return result.stdout;
}

// Reads quota and the model list, cached for a few minutes per store.
export function readQuota({ cwd, env = process.env, cacheFile, now = Date.now(), refresh = false }) {
  if (cacheFile && !refresh && existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
      if (now - cached.at < CACHE_MS) return cached;
    } catch {
      // refetch
    }
  }
  const quota = {
    at: now,
    limits: parseUsage(runAgy(['-p', '/usage'], { cwd, env })),
    models: parseModels(runAgy(['models'], { cwd, env })),
  };
  if (cacheFile) {
    mkdirSync(dirname(cacheFile), { recursive: true, mode: 0o700 });
    writeFileSync(cacheFile, JSON.stringify(quota), { mode: 0o600 });
  }
  return quota;
}
