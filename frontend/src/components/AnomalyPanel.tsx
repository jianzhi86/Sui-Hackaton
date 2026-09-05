import type { AnomalyReportResult } from '../lib/types';

const CONSENSUS_LABEL: Record<AnomalyReportResult['consensus'], string> = {
  clear: 'No anomalies found',
  flag: 'Flagged',
  needs_review: 'Needs review',
  unavailable: 'AI unavailable',
};

export function AnomalyPanel({ report }: { report: AnomalyReportResult }) {
  return (
    <div className="panel" style={{ marginTop: 16, background: 'var(--paper)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ fontFamily: 'var(--font-display)', margin: 0 }}>Transparency report</h3>
        <span className={`status-badge status-${report.consensus}`}>
          {CONSENSUS_LABEL[report.consensus]}
          {report.combinedRiskScore !== null && ` · ${report.combinedRiskScore}/100`}
        </span>
      </div>

      {report.ruleFindings.length > 0 && (
        <>
          <p className="helper-text" style={{ marginBottom: 0 }}>
            Rule-based findings (computed locally, before any AI call):
          </p>
          <ul className="finding-list">
            {report.ruleFindings.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </>
      )}

      {report.models.length === 1 && <p className="helper-text">Only one model returned a valid result; independent verification is incomplete.</p>}
      {report.models.length === 0 ? (
        <p className="error-text" style={{ marginTop: 12 }}>
          No valid AI result was available. This report only reflects local rules.
        </p>
      ) : (
        <div className="model-grid">
          {report.models.map((m) => (
            <div className="model-card" key={m.model}>
              <div className="model-card-head">
                <span className="model-name">{m.model}</span>
                <span className="model-score">{m.riskScore}/100</span>
              </div>
              <span className={`status-badge status-${m.verdict === 'flag' ? 'flag' : 'clear'}`}>
                {m.verdict}
              </span>
              <p style={{ fontSize: 13, marginTop: 8 }}>{m.reasoning}</p>
              <p className="helper-text" style={{ marginBottom: 0 }}>
                Gonka request ID: <span className="code-chip">{m.requestId}</span>
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
