import { useCurrentAccount, useSuiClientQuery } from '@mysten/dapp-kit';

/**
 * Checks whether the connected wallet's address is a member of a shared
 * allow-list object (`RegulatorRegistry.regulators`,
 * `ManufacturerRegistry.manufacturers`, or `AdminRegistry.admins` — all
 * three are plain `VecSet<address>` fields, which serialize as
 * `{ contents: [...] }`, so this reads them directly rather than calling
 * into Move for what's just a field read). Used for all three registries
 * since they're structurally identical allow-lists.
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
