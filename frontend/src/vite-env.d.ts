/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUI_NETWORK?: 'devnet' | 'testnet' | 'mainnet';
  readonly VITE_PACKAGE_ID?: string;
  readonly VITE_GONKA_MODEL_A?: string;
  readonly VITE_GONKA_MODEL_B?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
