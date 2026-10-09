import type { ParentReport } from '#contracts/ClassroomInsights.js';

function escapeReportText(text: string): string {
  return text.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** Renders only the exact approved single-child snapshot; no script, assets or private evidence links. */
export function formatParentReportHtml(report: ParentReport): string {
  const escape = escapeReportText;
  const rows = report.sessions
    .map(
      (session) =>
        `<tr><td>${escape(session.observedAt)}</td><td>${String(session.counts.met)}</td><td>${String(session.counts.needsChanges)}</td><td>${String(session.counts.insufficient + session.counts.notChecked)}</td><td>${String(session.counts.conflict)}</td><td>${String(session.counts.removed)}</td><td>${String(session.counts.total)}</td></tr>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escape(report.studentName)} · Learning report</title><style>body{font:16px/1.6 system-ui,sans-serif;color:#172b25;max-width:800px;margin:48px auto;padding:0 24px;overflow-wrap:anywhere}h1{line-height:1.2}section{margin:28px 0}.note{color:#52635c;font-size:14px}.commentary{white-space:pre-wrap}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;border-bottom:1px solid #dce3df;padding:8px}@media print{body{margin:0;max-width:none}section{break-inside:avoid}}</style></head><body>
<header><p>Learning report</p><h1>${escape(report.studentName)}</h1><p class="note">Reporting period: ${escape(report.identity.window.from)} to ${escape(report.identity.window.to)} · ${escape(report.identity.window.timezone)}</p></header>
<section><h2>Learning and next steps</h2>${report.facts.map((fact) => `<p>${escape(fact.text)}</p>`).join('')}</section>
<section><h2>Lesson results</h2><p class="note">Counts refer to lesson criteria, including supported work. Missing results are not a measure of ability.</p><table><thead><tr><th>Lesson date</th><th>Met</th><th>Needs practice</th><th>No result</th><th>Review</th><th>Removed</th><th>Criteria</th></tr></thead><tbody>${rows}</tbody></table></section>
${report.commentary ? `<section><h2>Teacher’s note</h2><p class="commentary">${escape(report.commentary)}</p></section>` : ''}
<footer class="note">Approved revision ${String(report.version)} · ${escape(report.approvedAt ?? '')}<br>Source cutoff ${escape(report.identity.sourceRevision)} · ${escape(report.identity.derivationVersion)}</footer>
</body></html>`;
}
