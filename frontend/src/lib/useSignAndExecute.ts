import { useSuiClient, useSignAndExecuteTransaction } from '@mysten/dapp-kit';

/**
 * Thin wrapper around dapp-kit's useSignAndExecuteTransaction that always
 * asks for object changes back, so callers (like the register-batch form)
 * can read the newly created object's ID straight off the result.
 */
export function useSignAndExecute() {
  const client = useSuiClient();

  return useSignAndExecuteTransaction({
    execute: async ({ bytes, signature }) =>
      client.executeTransactionBlock({
        transactionBlock: bytes,
        signature,
        options: {
          showRawEffects: true,
          showObjectChanges: true,
        },
      }),
  });
}
