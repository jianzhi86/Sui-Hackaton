import { useCurrentAccount, useSuiClient } from '@mysten/dapp-kit';
import { useQuery } from '@tanstack/react-query';
import { TYPE_PACKAGE_ID } from '../lib/network';
import { fetchAllEvents } from '../lib/activeHolds';
import { CodeChip } from './CodeChip';

interface MyBatchRow {
  batchId: string;
  batchCode: string;
  productName: string;
  createdAtMs: number;
  expiryMs: number;
}

interface MyBatchesPanelProps {
  onSelectBatch: (batchId: string) => void;
}

/**
 * A manufacturer with several registered batches otherwise has no way to
 * find them again short of digging up each object ID from wherever they
 * saved it after registering — this lists every batch created by the
 * connected wallet, read straight from `BatchCreated` events like the
 * Active Holds / Stats dashboards, no separate on-chain index needed.
 */
export function MyBatchesPanel({ onSelectBatch }: MyBatchesPanelProps) {
  const account = useCurrentAccount();
  const client = useSuiClient();

  const { data, isLoading, isError, isFetching, refetch, dataUpdatedAt } = useQuery({
    queryKey: ['myBatches', TYPE_PACKAGE_ID, account?.address],
    queryFn: async (): Promise<MyBatchRow[]> => {
      const created = await fetchAllEvents(client, `${TYPE_PACKAGE_ID}::batch::BatchCreated`);
      return created
        .map((e) => {
          const pj = (e?.parsedJson ?? {}) as Record<string, unknown>;
          return {
            batchId: String(pj.batch_id ?? ''),
            batchCode: String(pj.batch_code ?? ''),
            productName: String(pj.product_name ?? ''),
            manufacturer: String(pj.manufacturer ?? ''),
            createdAtMs: Number(pj.created_at_ms ?? e?.timestampMs ?? 0),
            expiryMs: Number(pj.expiry_ms ?? 0),
          };
        })
        .filter((b) => b.manufacturer === account?.address && b.batchId)
        .sort((a, b) => b.createdAtMs - a.createdAtMs);
    },
    enabled: Boolean(account),
  });

  if (!account) return null;

  const batches = data ?? [];

  return (
    <div style={{ marginTop: 24 }}>
      <details open={batches.length > 0}>
        <summary className="helper-text" style={{ cursor: 'pointer' }}>
          Your registered batches{batches.length > 0 && ` (${batches.length})`}
        </summary>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, marginBottom: 8 }}>
          <button type="button" className="btn btn-secondary" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
          {dataUpdatedAt > 0 && !isFetching && (
            <span className="helper-text">Last updated {new Date(dataUpdatedAt).toLocaleTimeString()}</span>
          )}
        </div>

        {isLoading && <p className="helper-text">Reading your batches from Sui…</p>}
        {isError && <p className="error-text">Could not read your batches from Sui. Try again shortly.</p>}
        {!isLoading && !isError && batches.length === 0 && (
          <p className="helper-text">You haven't registered any batches with this wallet yet.</p>
        )}

        {batches.length > 0 && (
          <div className="ledger">
            {batches.map((b) => (
              <div className="ledger-entry" key={b.batchId}>
                <span className="ledger-dot">▤</span>
                <div className="ledger-role">{b.productName}</div>
                <div className="ledger-meta">
                  <span className="code-chip">{b.batchCode}</span> · registered{' '}
                  {new Date(b.createdAtMs).toLocaleString()} · expires{' '}
                  {b.expiryMs > 0 ? new Date(b.expiryMs).toLocaleDateString() : 'unknown'}
                </div>
                <div className="helper-text">
                  <CodeChip value={b.batchId} />
                </div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ marginTop: 6 }}
                  onClick={() => onSelectBatch(b.batchId)}
                >
                  View batch
                </button>
              </div>
            ))}
          </div>
        )}
      </details>
    </div>
  );
}
