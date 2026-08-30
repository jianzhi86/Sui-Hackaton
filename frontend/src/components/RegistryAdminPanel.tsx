import { useState, type FormEvent } from 'react';
import { Transaction } from '@mysten/sui/transactions';
import { DEFAULT_NETWORK, target } from '../lib/network';
import { useSignAndExecute } from '../lib/useSignAndExecute';
import { useToast } from '../lib/toast';

interface RegistryAdminPanelProps {
  adminCapId: string;
  registryObjectId: string;
  /** Move entry function name that adds an address, e.g. "admin_add_regulator". */
  addFn: string;
  /** Move entry function name that removes an address, e.g. "admin_revoke_regulator". */
  revokeFn: string;
  /** Human label for what this allow-list controls, e.g. "regulator" or "manufacturer". */
  roleLabel: string;
  onChanged: () => void;
}

/**
 * Generic add/revoke UI for an `AdminCap`-controlled address allow-list.
 * Shared by the regulator and manufacturer registries — both are the same
 * `AdminCap` + `VecSet<address>` shape in Move, so one component covers
 * both instead of duplicating the form twice.
 */
export function RegistryAdminPanel({
  adminCapId,
  registryObjectId,
  addFn,
  revokeFn,
  roleLabel,
  onChanged,
}: RegistryAdminPanelProps) {
  const { mutate: signAndExecute, isPending } = useSignAndExecute();
  const toast = useToast();
  const [addAddress, setAddAddress] = useState('');
  const [revokeAddress, setRevokeAddress] = useState('');
  const [error, setError] = useState<string | null>(null);

  function handleAdd(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!addAddress.trim()) {
      setError('An address is required.');
      return;
    }

    const tx = new Transaction();
    tx.moveCall({
      target: target(addFn),
      arguments: [tx.object(adminCapId), tx.object(registryObjectId), tx.pure.address(addAddress.trim())],
    });

    signAndExecute(
      { transaction: tx, chain: `sui:${DEFAULT_NETWORK}` as `sui:${string}` },
      {
        onSuccess: () => {
          toast.success(`${addAddress.trim()} added as a ${roleLabel}.`);
          setAddAddress('');
          onChanged();
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  function handleRevoke(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!revokeAddress.trim()) {
      setError('An address is required.');
      return;
    }

    const tx = new Transaction();
    tx.moveCall({
      target: target(revokeFn),
      arguments: [tx.object(adminCapId), tx.object(registryObjectId), tx.pure.address(revokeAddress.trim())],
    });

    signAndExecute(
      { transaction: tx, chain: `sui:${DEFAULT_NETWORK}` as `sui:${string}` },
      {
        onSuccess: () => {
          toast.success(`${revokeAddress.trim()} revoked as a ${roleLabel}.`);
          setRevokeAddress('');
          onChanged();
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <details style={{ marginTop: 12 }}>
      <summary className="helper-text" style={{ cursor: 'pointer' }}>
        Admin: manage {roleLabel} access
      </summary>
      <div style={{ marginTop: 8 }}>
        <form onSubmit={handleAdd}>
          <div className="field">
            <label htmlFor={`add-${roleLabel}`}>Add {roleLabel} address</label>
            <input
              id={`add-${roleLabel}`}
              value={addAddress}
              onChange={(e) => setAddAddress(e.target.value)}
              placeholder="0x…"
              disabled={isPending}
            />
          </div>
          <button type="submit" className="btn btn-secondary" disabled={isPending}>
            {isPending ? 'Adding…' : `Add ${roleLabel}`}
          </button>
        </form>

        <form onSubmit={handleRevoke} style={{ marginTop: 12 }}>
          <div className="field">
            <label htmlFor={`revoke-${roleLabel}`}>Revoke {roleLabel} address</label>
            <input
              id={`revoke-${roleLabel}`}
              value={revokeAddress}
              onChange={(e) => setRevokeAddress(e.target.value)}
              placeholder="0x…"
              disabled={isPending}
            />
          </div>
          <button type="submit" className="btn btn-danger" disabled={isPending}>
            {isPending ? 'Revoking…' : `Revoke ${roleLabel}`}
          </button>
        </form>

        {error && <p className="error-text">{error}</p>}
      </div>
    </details>
  );
}
