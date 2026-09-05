import { useSuiClient, useSignAndExecuteTransaction } from '@mysten/dapp-kit';

/**
 * Thin wrapper around dapp-kit's useSignAndExecuteTransaction that always
 * asks for object changes back, so callers (like the register-batch form)
 * can read the newly created object's ID straight off the result.
 */
export function useSignAndExecute() {
  const client = useSuiClient();

  return useSignAndExecuteTransaction({
    execute: async ({ bytes, signature }) => {
      const result = await client.executeTransactionBlock({
        transactionBlock: bytes,
        signature,
        options: {
          showRawEffects: true,
          showEffects: true,
          showObjectChanges: true,
        },
      });
      if (result.effects?.status.status !== 'success') {
        throw new Error(result.effects?.status.error || 'Transaction success could not be confirmed. Check the transaction before retrying.');
      }
      return result;
    },
  });
}
