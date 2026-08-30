import { useCurrentAccount, useSuiClientQuery } from '@mysten/dapp-kit';
import { PACKAGE_ID } from './network';

/**
 * Checks whether the connected wallet's address is a member of a shared
 * allow-list object (`RegulatorRegistry.regulators` or
 * `ManufacturerRegistry.manufacturers` — both are plain `VecSet<address>`
 * fields, which serialize as `{ contents: [...] }`, so this reads them
 * directly rather than calling into Move for what's just a field read).
 * Used for both registries since they're structurally identical allow-lists.
 */
export function useIsListed(registryObjectId: string, fieldName: string) {
  const account = useCurrentAccount();
  const { data, isLoading, refetch } = useSuiClientQuery(
    'getObject',
    { id: registryObjectId, options: { showContent: true } },
    { staleTime: 0, refetchOnMount: 'always' },
  );

  const content = data?.data?.content;
  const members: string[] =
    content && content.dataType === 'moveObject'
      ? ((content.fields as any)?.[fieldName]?.fields?.contents ?? [])
      : [];

  const isListed = Boolean(account && members.includes(account.address));
  return { isListed, members, isLoading, refetch };
}

/** Whether the connected wallet holds the `AdminCap` that can add/revoke
 * entries in either registry. Unlike registry membership, this really is
 * a bearer capability object — see the Move module doc comment on
 * `AdminCap` for why that's an accepted tradeoff for the admin role. */
export function useAdminCap() {
  const account = useCurrentAccount();
  const { data, isLoading, refetch } = useSuiClientQuery(
    'getOwnedObjects',
    {
      owner: account?.address ?? '',
      filter: { StructType: `${PACKAGE_ID}::batch::AdminCap` },
      options: { showContent: false },
    },
    { enabled: Boolean(account) },
  );

  const adminCapId = data?.data?.[0]?.data?.objectId ?? null;
  return { adminCapId, isLoading, refetch };
}
