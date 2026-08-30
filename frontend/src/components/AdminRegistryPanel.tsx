import { useState, type FormEvent } from 'react';
import { Transaction } from '@mysten/sui/transactions';
import { ADMIN_REGISTRY_OBJECT_ID, DEFAULT_NETWORK, target } from '../lib/network';
import { useSignAndExecute } from '../lib/useSignAndExecute';
import { useToast } from '../lib/toast';

interface AdminRegistryPanelProps {
  onChanged: () => void;
}

/**
 * Add/remove UI for `AdminRegistry` itself — seeding a backup admin, or
 * removing one. Separate from `RegistryAdminPanel` because `admin_add_admin`
 * / `admin_remove_admin` take a single mutable `AdminRegistry` reference,
 * not an admin-registry-plus-target-registry pair like the regulator/
 * manufacturer admin actions do.
 */
export function AdminRegistryPanel({ onChanged }: AdminRegistryPanelProps) {
  const { mutate: signAndExecute, isPending } = useSignAndExecute();
  const toast = useToast();
  const [addAddress, setAddAddress] = useState('');
  const [removeAddress, setRemoveAddress] = useState('');
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
      target: target('admin_add_admin'),
      arguments: [tx.object(ADMIN_REGISTRY_OBJECT_ID), tx.pure.address(addAddress.trim())],
    });

    signAndExecute(
      { transaction: tx, chain: `sui:${DEFAULT_NETWORK}` as `sui:${string}` },
      {
        onSuccess: () => {
          toast.success(`${addAddress.trim()} added as a backup admin.`);
          setAddAddress('');
          onChanged();
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  function handleRemove(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!removeAddress.trim()) {
      setError('An address is required.');
      return;
    }

    const tx = new Transaction();
    tx.moveCall({
      target: target('admin_remove_admin'),
      arguments: [tx.object(ADMIN_REGISTRY_OBJECT_ID), tx.pure.address(removeAddress.trim())],
    });

    signAndExecute(
      { transaction: tx, chain: `sui:${DEFAULT_NETWORK}` as `sui:${string}` },
      {
        onSuccess: () => {
          toast.success(`${removeAddress.trim()} removed as admin.`);
          setRemoveAddress('');
          onChanged();
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <details style={{ marginTop: 12 }}>
      <summary className="helper-text" style={{ cursor: 'pointer' }}>
        Admin: manage admin access
      </summary>
      <div style={{ marginTop: 8 }}>
        <p className="helper-text">
          Add a backup admin before you ever need one — the last remaining admin can't be removed,
          so a registry with only you in it is one lost key away from nobody ever being able to
          change either allow-list again.
        </p>
        <form onSubmit={handleAdd}>
          <div className="field">
            <label htmlFor="add-admin">Add admin address</label>
            <input
              id="add-admin"
              value={addAddress}
              onChange={(e) => setAddAddress(e.target.value)}
              placeholder="0x…"
              disabled={isPending}
            />
          </div>
          <button type="submit" className="btn btn-secondary" disabled={isPending}>
            {isPending ? 'Adding…' : 'Add admin'}
          </button>
        </form>

        <form onSubmit={handleRemove} style={{ marginTop: 12 }}>
          <div className="field">
            <label htmlFor="remove-admin">Remove admin address</label>
            <input
              id="remove-admin"
              value={removeAddress}
              onChange={(e) => setRemoveAddress(e.target.value)}
              placeholder="0x…"
              disabled={isPending}
            />
          </div>
          <button type="submit" className="btn btn-danger" disabled={isPending}>
            {isPending ? 'Removing…' : 'Remove admin'}
          </button>
        </form>

        {error && <p className="error-text">{error}</p>}
      </div>
    </details>
  );
}
