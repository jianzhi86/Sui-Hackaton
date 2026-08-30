import { useState, type FormEvent } from 'react';
import { useCurrentAccount, useSuiClientQuery } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import {
  ADMIN_REGISTRY_OBJECT_ID,
  CLOCK_OBJECT_ID,
  DEFAULT_NETWORK,
  MANUFACTURER_REGISTRY_OBJECT_ID,
  PHARMACY_REGISTRY_OBJECT_ID,
  REGISTRY_OBJECT_ID,
  target,
} from '../lib/network';
import { useSignAndExecute } from '../lib/useSignAndExecute';
import { useIsListed } from '../lib/registry';
import { useToast } from '../lib/toast';
import { CodeChip } from './CodeChip';
import { explorerAddressUrl } from '../lib/explorer';

const ACTION_LABELS: Record<number, string> = {
  1: 'Add regulator',
  2: 'Revoke regulator',
  3: 'Add manufacturer',
  4: 'Revoke manufacturer',
  5: 'Add pharmacy',
  6: 'Revoke pharmacy',
  7: 'Add admin',
  8: 'Remove admin',
};

interface AdminActionPanelProps {
  onChanged: () => void;
}

/**
 * Once `AdminRegistry` has more than one admin, sensitive admin actions
 * (add/revoke regulator, manufacturer, pharmacy, or admin) require a
 * `propose_admin_action` from one admin followed by `confirm_admin_action`
 * from a *different* one, mirroring the two-signer Critical hold release.
 * While there's only one admin, the direct `admin_add_*`/`admin_revoke_*`
 * calls (in the other admin panels) still work single-signer, since
 * there'd be nobody else around to confirm anything.
 */
export function AdminActionPanel({ onChanged }: AdminActionPanelProps) {
  const account = useCurrentAccount();
  const { mutate: signAndExecute, isPending } = useSignAndExecute();
  const toast = useToast();
  const { members: admins, refetch: refetchAdmins } = useIsListed(ADMIN_REGISTRY_OBJECT_ID, 'admins');

  const [actionKind, setActionKind] = useState('1');
  const [targetAddr, setTargetAddr] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data, refetch: refetchRegistry } = useSuiClientQuery(
    'getObject',
    { id: ADMIN_REGISTRY_OBJECT_ID, options: { showContent: true } },
    { staleTime: 0, refetchOnMount: 'always' },
  );

  const content = data?.data?.content;
  const fields =
    content && content.dataType === 'moveObject' ? (content.fields as Record<string, any>) : null;
  const pendingVec = fields?.pending_action?.fields?.vec ?? [];
  const pending =
    pendingVec.length > 0
      ? {
          actionKind: Number(pendingVec[0].fields.action_kind),
          targetAddr: String(pendingVec[0].fields.target_addr),
          proposedBy: String(pendingVec[0].fields.proposed_by),
          proposedAtMs: Number(pendingVec[0].fields.proposed_at_ms),
        }
      : null;

  const multiAdmin = admins.length > 1;
  const isProposer = Boolean(account && pending && account.address === pending.proposedBy);

  function refetchAll() {
    refetchAdmins();
    refetchRegistry();
    onChanged();
  }

  function handlePropose(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!targetAddr.trim()) {
      setError('A target address is required.');
      return;
    }

    const tx = new Transaction();
    tx.moveCall({
      target: target('propose_admin_action'),
      arguments: [
        tx.object(ADMIN_REGISTRY_OBJECT_ID),
        tx.pure.u8(Number(actionKind)),
        tx.pure.address(targetAddr.trim()),
        tx.object(CLOCK_OBJECT_ID),
      ],
    });

    signAndExecute(
      { transaction: tx, chain: `sui:${DEFAULT_NETWORK}` as `sui:${string}` },
      {
        onSuccess: () => {
          toast.success('Admin action proposed — waiting on a second, different admin to confirm.');
          setTargetAddr('');
          refetchAll();
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  function handleConfirm() {
    setError(null);
    const tx = new Transaction();
    tx.moveCall({
      target: target('confirm_admin_action'),
      arguments: [
        tx.object(ADMIN_REGISTRY_OBJECT_ID),
        tx.object(REGISTRY_OBJECT_ID),
        tx.object(MANUFACTURER_REGISTRY_OBJECT_ID),
        tx.object(PHARMACY_REGISTRY_OBJECT_ID),
        tx.object(CLOCK_OBJECT_ID),
      ],
    });

    signAndExecute(
      { transaction: tx, chain: `sui:${DEFAULT_NETWORK}` as `sui:${string}` },
      {
        onSuccess: () => {
          toast.success('Admin action confirmed and applied.');
          refetchAll();
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  if (!multiAdmin) {
    return (
      <p className="helper-text" style={{ marginTop: 8 }}>
        Only one admin exists — admin actions above take effect immediately, single-signer. Once a
        second admin is added, sensitive admin actions require propose + confirm from two different
        admins instead.
      </p>
    );
  }

  return (
    <div className="hold-banner" style={{ marginTop: 12 }}>
      <strong>Two-signer admin actions ({admins.length} admins listed)</strong>
      <p className="helper-text" style={{ marginTop: 4 }}>
        With more than one admin, add/revoke actions on the regulator, manufacturer, pharmacy, and
        admin registries require a proposal from one admin and confirmation from a different one.
      </p>
      {error && <p className="error-text">{error}</p>}

      {pending ? (
        <div>
          <p className="helper-text">
            Pending: <strong>{ACTION_LABELS[pending.actionKind] ?? `action ${pending.actionKind}`}</strong>{' '}
            on <CodeChip value={pending.targetAddr} href={explorerAddressUrl(pending.targetAddr)} />,
            proposed by <CodeChip value={pending.proposedBy} href={explorerAddressUrl(pending.proposedBy)} /> at{' '}
            {new Date(pending.proposedAtMs).toLocaleString()}.
          </p>
          {isProposer ? (
            <p className="error-text">You proposed this — a different admin must confirm it, not you.</p>
          ) : (
            <button type="button" className="btn btn-danger" onClick={handleConfirm} disabled={!account || isPending}>
              {isPending ? 'Confirming…' : 'Confirm pending action'}
            </button>
          )}
        </div>
      ) : (
        <form onSubmit={handlePropose}>
          <div className="field-row">
            <div className="field">
              <label htmlFor="actionKind">Action</label>
              <select
                id="actionKind"
                value={actionKind}
                onChange={(e) => setActionKind(e.target.value)}
                disabled={!account || isPending}
              >
                {Object.entries(ACTION_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="targetAddr">Target address</label>
              <input
                id="targetAddr"
                value={targetAddr}
                onChange={(e) => setTargetAddr(e.target.value)}
                placeholder="0x…"
                disabled={!account || isPending}
              />
            </div>
          </div>
          <button type="submit" className="btn btn-secondary" disabled={!account || isPending}>
            {isPending ? 'Proposing…' : 'Propose action'}
          </button>
        </form>
      )}
    </div>
  );
}
