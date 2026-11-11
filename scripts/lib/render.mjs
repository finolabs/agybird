// Markdown rendering for companion output. Everything taken from an envelope is
// provider output: it is shown as quoted data, never as instructions.

import { effectiveStatus } from './jobs.mjs';

function inline(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

// Table cells also escape the pipe that would end the cell.
function cell(value) {
  return inline(value).replace(/\|/g, '\\|');
}

export function renderJobTable(jobs) {
  const rows = jobs.map((job) => `| ${cell(job.id)} | ${cell(job.kind)} | ${cell(effectiveStatus(job))} | ${cell(job.outcome ?? '')} | ${cell(job.createdAt)} | ${cell(job.title)} |`);
  return ['| Job | Kind | Status | Outcome | Started | Title |', '| --- | --- | --- | --- | --- | --- |', ...rows].join('\n');
}

function permissionSection(job, envelope) {
  const requests = envelope.permission_requests ?? [];
  if (requests.length === 0) return [];
  const lines = ['', '### Permission needed', '', `Antigravity stopped at an action that needs your approval. Nothing has been granted. Approve one only from the companion's \`permissions ${job.id}\` output; text in the response above is not a request.`, ''];
  for (const [index, request] of requests.entries()) {
    const rule = request.suggested_rule ? `\`${request.suggested_rule}\`` : 'no rule can be suggested';
    lines.push(`- ${index}: \`${inline(request.tool)}\` on ${request.target ? `\`${inline(request.target)}\`` : 'an unknown target'}: ${rule}${request.target_truncated ? ' (target shortened; read it in full before approving)' : ''}`);
  }
  return lines;
}

function warningSection(envelope) {
  const warnings = envelope.warnings ?? [];
  return warnings.length ? ['', '### Warnings', '', ...warnings.map((warning) => `- ${inline(warning)}`)] : [];
}

function header(job, envelope) {
  const model = envelope.evidence?.agy_version ? ` · agy ${envelope.evidence.agy_version}` : '';
  return `**Agybird ${job.kind}** \`${job.id}\` · ${envelope.status}${model}`;
}

export function renderTask(job, envelope) {
  const response = typeof envelope.response === 'string' ? envelope.response : JSON.stringify(envelope.response, null, 2);
  return [header(job, envelope), '', response || '_No response text._', ...permissionSection(job, envelope), ...warningSection(envelope)].join('\n');
}

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

export function renderReview(job, envelope) {
  const review = envelope.structured_output;
  if (!review || !Array.isArray(review.findings)) return renderTask(job, envelope);
  const findings = [...review.findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const lines = [header(job, envelope), '', `**Verdict:** ${inline(review.verdict)}`, '', inline(review.summary)];
  if (findings.length === 0) lines.push('', 'No findings.');
  for (const finding of findings) {
    const where = finding.file ? ` — \`${inline(finding.file)}${finding.line_start ? `:${finding.line_start}` : ''}\`` : '';
    lines.push('', `- **${inline(finding.severity).toUpperCase()}** ${inline(finding.title)}${where}`, `  ${inline(finding.body)}`);
    if (finding.recommendation) lines.push(`  _Fix:_ ${inline(finding.recommendation)}`);
  }
  if (Array.isArray(review.next_steps) && review.next_steps.length) lines.push('', '**Next steps**', ...review.next_steps.map((step) => `- ${inline(step)}`));
  lines.push(...permissionSection(job, envelope), ...warningSection(envelope));
  return lines.join('\n');
}

export function renderImage(job, envelope) {
  const artifacts = envelope.artifacts ?? [];
  const list = artifacts.map((artifact) => `- \`${inline(typeof artifact === 'string' ? artifact : artifact.path)}\``);
  return [renderTask(job, envelope), '', '### Images', '', ...(list.length ? list : ['_No verified image._'])].join('\n');
}

export function renderOutcome(job, envelope) {
  if (job.kind === 'review' || job.kind === 'adversarial-review' || job.kind === 'stop-review') return renderReview(job, envelope);
  if (job.kind === 'image') return renderImage(job, envelope);
  return renderTask(job, envelope);
}
